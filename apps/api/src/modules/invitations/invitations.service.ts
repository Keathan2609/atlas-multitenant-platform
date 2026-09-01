import { createHash, randomBytes } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { newId } from '@atlas/database';
import type { Logger } from '@atlas/observability';
import { type OrganizationRole, assignableRoles } from '@atlas/types';
import type { TenantContext } from '../../common/http/express.js';
import { CONFIG_TOKEN, type AppConfig } from '../../config/env.js';
import { LOGGER_TOKEN } from '../../common/logging/logger.provider.js';
import { PrismaService } from '../../common/database/prisma.service.js';
import { EmailService } from '../../common/email/email.service.js';
import { AuditAction, AuditService, type AuditEvent } from '../../common/audit/audit.service.js';
import {
  ConflictError,
  ErrorCode,
  ForbiddenError,
  NotFoundError,
  UnauthenticatedError,
} from '../../common/errors/app-error.js';

const TOKEN_BYTES = 32;
const INVITATION_TTL_DAYS = 7;

type RequestContext = Pick<AuditEvent, 'ipAddress' | 'userAgent'>;

@Injectable()
export class InvitationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly email: EmailService,
    @Inject(CONFIG_TOKEN) private readonly config: AppConfig,
    @Inject(LOGGER_TOKEN) private readonly logger: Logger,
  ) {}

  /**
   * SHA-256 of the raw token, same reasoning as sessions and API keys: the raw
   * value exists only in the emailed link, so a database dump yields no usable
   * invitations. A fast hash is right because the token is 256 bits of CSPRNG
   * output — there is no dictionary to attack.
   */
  private hash(token: string): string {
    return createHash('sha256').update(token, 'utf8').digest('hex');
  }

  /**
   * Invites someone to the organization.
   *
   * The role is checked against `assignableRoles` for the *actor*, not just
   * against the MEMBERS_INVITE permission. Without that an ADMIN could invite
   * an OWNER and escalate in one step through an account they control — the
   * same rule canChangeRole enforces on existing members, applied at the entry
   * point.
   */
  async invite(
    tenant: TenantContext,
    actorId: string,
    email: string,
    role: OrganizationRole,
    requestContext: RequestContext,
  ) {
    if (!assignableRoles(tenant.role).includes(role)) {
      throw new ForbiddenError(
        ErrorCode.CANNOT_GRANT_ABOVE_OWN_ROLE,
        'You cannot invite someone at a role above your own.',
      );
    }

    const db = this.prisma.forTenant(tenant.organizationId);
    await this.assertDomainAllowed(tenant, email);

    // Already a member? Say so rather than sending an invitation that would
    // fail on acceptance.
    const existingUser = await this.prisma.unscoped.user.findUnique({
      where: { email },
      select: { id: true },
    });
    if (existingUser) {
      const membership = await db.organizationMembership.findFirst({
        where: { userId: existingUser.id },
        select: { id: true },
      });
      if (membership) {
        throw new ConflictError(
          ErrorCode.ALREADY_A_MEMBER,
          'That person is already a member of this organization.',
        );
      }
    }

    const pending = await db.invitation.findFirst({
      where: { email, status: 'PENDING' },
      select: { id: true, expiresAt: true },
    });
    if (pending && pending.expiresAt > new Date()) {
      throw new ConflictError(
        ErrorCode.INVITATION_ALREADY_SENT,
        'An invitation is already outstanding for that address.',
      );
    }

    const rawToken = randomBytes(TOKEN_BYTES).toString('base64url');
    const expiresAt = new Date(Date.now() + INVITATION_TTL_DAYS * 24 * 60 * 60 * 1000);
    const invitationId = newId();

    await db.$transaction(async (tx) => {
      // A superseded invitation is marked EXPIRED rather than deleted, so the
      // audit trail keeps the fact that it was issued.
      if (pending) {
        await tx.invitation.update({ where: { id: pending.id }, data: { status: 'EXPIRED' } });
      }

      await tx.invitation.create({
        data: {
          id: invitationId,
          email,
          role,
          invitedById: actorId,
          tokenHash: this.hash(rawToken),
          expiresAt,
        } as never,
      });

      await this.audit.record(
        {
          organizationId: tenant.organizationId,
          actorId,
          action: AuditAction.MEMBER_INVITED,
          resourceType: 'invitation',
          resourceId: invitationId,
          // Email and role only — never the token or its hash.
          metadata: { email, role },
          ...requestContext,
        },
        tx,
      );
    });

    // After the commit. A mail failure must not undo a persisted invitation.
    const link = `${this.config.APP_BASE_URL}/invitations/${rawToken}`;
    await this.email.send({
      to: email,
      subject: `You have been invited to ${tenant.name} on ATLAS`,
      text: [
        `You have been invited to join ${tenant.name} on ATLAS as ${role.toLowerCase()}.`,
        '',
        `Accept the invitation: ${link}`,
        '',
        `This link expires in ${INVITATION_TTL_DAYS} days.`,
        'If you were not expecting this, you can ignore this message.',
      ].join('\n'),
    });

    this.logger.info(
      { event: 'invitation.sent', organizationId: tenant.organizationId, invitationId, role },
      'Invitation sent',
    );

    return { id: invitationId, email, role, expiresAt, status: 'PENDING' as const };
  }

  async list(tenant: TenantContext) {
    const db = this.prisma.forTenant(tenant.organizationId);
    const now = new Date();

    const invitations = await db.invitation.findMany({
      where: { status: { in: ['PENDING', 'REVOKED'] } },
      select: {
        id: true,
        email: true,
        role: true,
        status: true,
        expiresAt: true,
        createdAt: true,
        invitedBy: { select: { id: true, displayName: true } },
      },
      orderBy: { createdAt: 'desc' },
    });

    return {
      data: invitations.map((invitation) => ({
        ...invitation,
        // Derived, like API-key status: a PENDING row past its expiry is
        // expired whether or not anything has written to it.
        status:
          invitation.status === 'PENDING' && invitation.expiresAt <= now
            ? ('EXPIRED' as const)
            : invitation.status,
      })),
    };
  }

  async revoke(
    tenant: TenantContext,
    actorId: string,
    invitationId: string,
    requestContext: RequestContext,
  ) {
    const db = this.prisma.forTenant(tenant.organizationId);

    const invitation = await db.invitation.findFirst({
      where: { id: invitationId },
      select: { id: true, email: true, status: true },
    });
    if (!invitation) {
      throw new NotFoundError(
        ErrorCode.INVITATION_NOT_FOUND,
        'That invitation could not be found.',
      );
    }
    if (invitation.status === 'ACCEPTED') {
      throw new ConflictError(
        ErrorCode.INVITATION_ALREADY_ACCEPTED,
        'That invitation has already been accepted. Remove the member instead.',
      );
    }

    await db.$transaction(async (tx) => {
      await tx.invitation.update({
        where: { id: invitationId },
        data: { status: 'REVOKED', revokedAt: new Date() },
      });
      await this.audit.record(
        {
          organizationId: tenant.organizationId,
          actorId,
          action: AuditAction.INVITATION_REVOKED,
          resourceType: 'invitation',
          resourceId: invitationId,
          metadata: { email: invitation.email },
          ...requestContext,
        },
        tx,
      );
    });
  }

  /**
   * Describes an invitation to an unauthenticated visitor holding the token.
   *
   * Returns the organization name and the invited address so the sign-in page
   * can say what is being accepted. The token is the only credential, which is
   * why it is 256 bits — but the response deliberately carries nothing beyond
   * what the recipient already knows from the email.
   */
  async preview(rawToken: string) {
    const invitation = await this.findLive(rawToken);
    return {
      email: invitation.email,
      role: invitation.role,
      organizationName: invitation.organization.name,
      organizationSlug: invitation.organization.slug,
      expiresAt: invitation.expiresAt,
    };
  }

  /**
   * Accepts an invitation for the signed-in user.
   *
   * Requires authentication rather than creating an account inline: the
   * membership must attach to a real, verified session, and mixing account
   * creation into acceptance would mean one endpoint that both authenticates
   * and authorises.
   *
   * The signed-in address must match the invited one. Without that check, a
   * forwarded link would let anyone who received it join the organization —
   * the invitation names a person, not merely an org.
   */
  async accept(userId: string, rawToken: string, requestContext: RequestContext) {
    const user = await this.prisma.unscoped.user.findUnique({
      where: { id: userId },
      select: { id: true, email: true },
    });
    if (!user) throw new UnauthenticatedError();

    const invitation = await this.findLive(rawToken);

    if (invitation.email !== user.email) {
      this.logger.warn(
        {
          event: 'security.invitation_email_mismatch',
          invitationId: invitation.id,
          userId,
        },
        'Invitation accepted by a different address than invited',
      );
      throw new ForbiddenError(
        ErrorCode.FORBIDDEN,
        'This invitation was sent to a different email address.',
      );
    }

    const organizationId = invitation.organizationId;

    // Scoped from here on. The tenant is unknown while the token is being
    // resolved — that is why findLive() is one of the reviewed unscoped
    // escape hatches — but once the invitation names its organization there
    // is no reason to keep the unscoped client for the writes. Every query
    // below then carries the tenant predicate even if a future edit forgets
    // to write it, which is the same correction applied to MembersService.
    const db = this.prisma.forTenant(organizationId);

    return db.$transaction(async (tx) => {
      // Re-read inside the transaction. Between findLive and here the
      // invitation could have been revoked or accepted by a concurrent
      // request; the status check must happen under the same lock as the
      // update that consumes it, or a token could be redeemed twice.
      const current = await tx.invitation.findUnique({
        where: { id: invitation.id },
        select: { status: true, expiresAt: true, role: true },
      });

      if (!current || current.status !== 'PENDING' || current.expiresAt <= new Date()) {
        throw new ConflictError(
          ErrorCode.INVITATION_EXPIRED,
          'That invitation is no longer valid.',
        );
      }

      const alreadyMember = await tx.organizationMembership.findFirst({
        where: { organizationId, userId },
        select: { id: true },
      });
      if (alreadyMember) {
        await tx.invitation.update({
          where: { id: invitation.id },
          data: { status: 'ACCEPTED', acceptedAt: new Date() },
        });
        throw new ConflictError(
          ErrorCode.ALREADY_A_MEMBER,
          'You are already a member of this organization.',
        );
      }

      await tx.organizationMembership.create({
        data: { id: newId(), organizationId, userId, role: current.role },
      });

      await tx.invitation.update({
        where: { id: invitation.id },
        data: { status: 'ACCEPTED', acceptedAt: new Date() },
      });

      await this.audit.record(
        {
          organizationId,
          actorId: userId,
          action: AuditAction.MEMBER_JOINED,
          resourceType: 'membership',
          resourceId: invitation.id,
          metadata: { email: user.email, role: current.role },
          ...requestContext,
        },
        tx,
      );

      this.logger.info(
        { event: 'invitation.accepted', organizationId, userId, invitationId: invitation.id },
        'Invitation accepted',
      );

      return {
        organizationId,
        organizationSlug: invitation.organization.slug,
        role: current.role,
      };
    });
  }

  /**
   * Resolves a raw token to a live invitation.
   *
   * Unknown, expired, revoked and already-accepted all raise the same
   * INVITATION_NOT_FOUND. Distinguishing them would let someone holding a
   * dead link learn whether it was ever real, and for which organization.
   *
   * Uses the unscoped client because acceptance happens before any tenant
   * context exists — the token *is* the claim. It is one of the few reviewed
   * escape hatches listed in docs/multi-tenancy.md.
   */
  private async findLive(rawToken: string) {
    if (!rawToken || rawToken.length < 32) {
      throw new NotFoundError(ErrorCode.INVITATION_NOT_FOUND, 'That invitation link is not valid.');
    }

    // Unscoped by necessity, same reasoning as API-key verification: the token
    // is the claim, and the recipient is not a member of the organization yet,
    // so there is no tenant context to scope by. Looked up by hash, never by
    // the raw token.
    const invitation = await this.prisma.unscoped.invitation.findUnique({
      // eslint-disable-next-line no-restricted-syntax
      where: { tokenHash: this.hash(rawToken) },
      select: {
        id: true,
        organizationId: true,
        email: true,
        role: true,
        status: true,
        expiresAt: true,
        organization: { select: { name: true, slug: true, deletedAt: true } },
      },
    });

    if (
      !invitation ||
      invitation.status !== 'PENDING' ||
      invitation.expiresAt <= new Date() ||
      invitation.organization.deletedAt
    ) {
      throw new NotFoundError(
        ErrorCode.INVITATION_NOT_FOUND,
        'That invitation link is not valid or has expired.',
      );
    }

    return invitation;
  }

  /**
   * Enforces the organization's email-domain restriction, when enabled.
   *
   * Checked at invitation time rather than acceptance so an administrator
   * learns immediately, instead of the recipient hitting a wall days later.
   */
  private async assertDomainAllowed(tenant: TenantContext, email: string): Promise<void> {
    const db = this.prisma.forTenant(tenant.organizationId);
    const settings = await db.organizationSettings.findFirst({
      where: { organizationId: tenant.organizationId },
      select: { restrictEmailDomains: true, allowedEmailDomains: true },
    });

    if (!settings?.restrictEmailDomains || settings.allowedEmailDomains.length === 0) return;

    const domain = email.split('@')[1]?.toLowerCase() ?? '';
    if (!settings.allowedEmailDomains.includes(domain)) {
      throw new ForbiddenError(
        ErrorCode.FORBIDDEN,
        `This organization only accepts members from: ${settings.allowedEmailDomains.join(', ')}.`,
      );
    }
  }
}
