'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { createOrganizationSchema, type CreateOrganizationInput } from '@atlas/validation';
import { Button, Field, Input } from '@/components/ui/primitives';
import { describeError } from '@/components/ui/states';
import { ApiError, api, applyFieldErrors } from '@/lib/api';
import { keys, useOrganizations } from '@/lib/queries';

/**
 * Create an organization.
 *
 * One field, plus the handle it will be reachable by. Everything an
 * organization needs to exist — the owner membership, its settings row, a
 * default workspace — is created server-side in the same transaction, so this
 * form is not a wizard and does not pretend to be one.
 */
export default function OnboardingPage() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const organizations = useOrganizations();
  const [formError, setFormError] = React.useState<string | null>(null);
  const [slugEdited, setSlugEdited] = React.useState(false);

  const {
    register,
    handleSubmit,
    setValue,
    watch,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<CreateOrganizationInput>({
    resolver: zodResolver(createOrganizationSchema),
    defaultValues: { name: '', slug: '' },
  });

  const name = watch('name');

  // The handle follows the name until someone types their own, at which point
  // it stops moving underneath them. The server derives one anyway when the
  // field is left empty; this is only so the URL is visible before committing.
  React.useEffect(() => {
    if (slugEdited) return;
    setValue('slug', slugify(name ?? ''));
  }, [name, slugEdited, setValue]);

  async function onSubmit(values: CreateOrganizationInput) {
    setFormError(null);
    try {
      const created = await api.post<{ slug: string }>('/organizations', {
        name: values.name,
        // An empty handle means "derive one" rather than "use the empty
        // string" — the field is optional server-side.
        ...(values.slug ? { slug: values.slug } : {}),
      });
      await queryClient.invalidateQueries({ queryKey: keys.organizations });
      router.replace(`/app/${created.slug}`);
    } catch (error) {
      if (!applyFieldErrors(error, setError as never)) {
        if (error instanceof ApiError && error.status === 409) {
          setError('slug', { type: 'server', message: 'That handle is already taken.' });
        } else {
          setFormError(describeError(error).description);
        }
      }
    }
  }

  const hasOrganizations = (organizations.data?.data.length ?? 0) > 0;

  return (
    <main className="flex min-h-dvh flex-col items-center justify-center bg-canvas px-4 py-10">
      <div className="w-full max-w-[400px]">
        <div className="mb-7">
          <p className="reference text-base font-medium tracking-tight text-fg">ATLAS</p>
          <h1 className="mt-4 text-lg font-semibold text-fg">Create an organization</h1>
          <p className="mt-1 text-sm text-fg-secondary">
            An organization holds your projects, teams, and members. You will be its owner.
          </p>
        </div>

        <form
          onSubmit={(event) => void handleSubmit(onSubmit)(event)}
          noValidate
          className="flex flex-col gap-4"
        >
          {formError && (
            <p
              role="alert"
              className="rounded-md border border-danger-border
                         bg-danger-subtle px-3 py-2 text-sm text-fg"
            >
              {formError}
            </p>
          )}

          <Field label="Name" htmlFor="name" error={errors.name?.message} required>
            <Input autoFocus invalid={Boolean(errors.name)} {...register('name')} />
          </Field>

          <Field
            label="Handle"
            htmlFor="slug"
            description="Used in every URL for this organization. It cannot be changed later."
            error={errors.slug?.message}
          >
            <Input
              className="reference"
              invalid={Boolean(errors.slug)}
              {...register('slug', {
                onChange: () => setSlugEdited(true),
              })}
            />
          </Field>

          <p className="-mt-1 text-xs text-fg-tertiary">
            Your workspace will live at{' '}
            <span className="reference text-fg-secondary">
              /app/{watch('slug') || 'your-handle'}
            </span>
          </p>

          <Button type="submit" variant="primary" loading={isSubmitting} className="mt-1 w-full">
            Create organization
          </Button>
        </form>

        {hasOrganizations && (
          <p className="mt-5 text-sm text-fg-secondary">
            Or{' '}
            <Link href="/organizations" className="text-accent hover:underline">
              go to an organization you already belong to
            </Link>
            .
          </p>
        )}
      </div>
    </main>
  );
}

/**
 * Mirrors the server's slug rules closely enough to preview the URL.
 *
 * The server remains authoritative — it derives, resolves collisions, and
 * validates. This only exists so the handle field is not empty while someone
 * types a name.
 */
function slugify(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 48);
}
