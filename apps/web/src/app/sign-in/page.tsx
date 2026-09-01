'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { loginSchema, type LoginInput } from '@atlas/validation';
import { ApiError, api, applyFieldErrors } from '@/lib/api';
import { Button, Field, Input } from '@/components/ui/primitives';
import { describeError } from '@/components/ui/states';
import type { OrganizationSummary } from '@/lib/queries';

/**
 * Sign in.
 *
 * A single-column form on the plain canvas. No split hero, no product
 * screenshot, no gradient panel — this page's only job is to get an engineer
 * into the tool in two fields, and anything else on it is in the way.
 *
 * The wordmark is set in the monospace face, which is the same signature the
 * application uses for references. It is the one place the identity appears at
 * all, and it earns its place by being consistent with what follows.
 */
export default function SignInPage() {
  // useSearchParams opts the subtree into client-side rendering, and Next
  // refuses to prerender a page that does so without a boundary — a failure
  // that only appears in a production build, never in dev. The fallback is the
  // page's own chrome, so nothing shifts when the form arrives.
  return (
    <React.Suspense fallback={<SignInFrame />}>
      <SignInForm />
    </React.Suspense>
  );
}

/** The static part of the page, shared by the form and its loading fallback. */
function SignInFrame({ children }: { children?: React.ReactNode }) {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center bg-canvas px-4 py-10">
      <div className="w-full max-w-[352px]">
        <div className="mb-7">
          <p className="reference text-base font-medium tracking-tight text-fg">ATLAS</p>
          <h1 className="mt-4 text-lg font-semibold text-fg">Sign in</h1>
        </div>
        {children}
      </div>
    </main>
  );
}

function SignInForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const queryClient = useQueryClient();
  const [formError, setFormError] = React.useState<string | null>(null);

  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<LoginInput>({
    resolver: zodResolver(loginSchema),
    defaultValues: { email: '', password: '' },
  });

  async function onSubmit(values: LoginInput) {
    setFormError(null);
    try {
      await api.post('/auth/login', values);

      // A new session means a new principal. Anything cached belongs to
      // whoever was signed in before — on a shared machine that is somebody
      // else's organization list — and staleTime would otherwise serve it for
      // the next thirty seconds before the first refetch replaced it.
      queryClient.clear();

      // Where to land is decided by what the account can actually reach, not
      // by a guess: one organization goes straight in, several go to the
      // picker, none goes to onboarding.
      const { data } = await api.get<{ data: OrganizationSummary[] }>('/organizations');
      const next = searchParams.get('next');

      if (next?.startsWith('/app/')) router.replace(next);
      else if (data.length === 1) router.replace(`/app/${data[0]!.slug}`);
      else if (data.length === 0) router.replace('/onboarding');
      else router.replace('/organizations');
    } catch (error) {
      // Field-level errors from the server take precedence; anything else
      // becomes the form-level message.
      if (!applyFieldErrors(error, setError as never)) {
        if (error instanceof ApiError && error.status === 401) {
          setFormError('That email address and password do not match.');
        } else {
          setFormError(describeError(error).description);
        }
      }
    }
  }

  return (
    <SignInFrame>
      <>
        <form
          onSubmit={(event) => void handleSubmit(onSubmit)(event)}
          noValidate
          className="flex flex-col gap-4"
        >
          {formError && (
            // Page-level, above the fields, and role="alert" so it is announced.
            // A toast would be wrong here: the message explains why the form
            // did not submit and belongs next to the form.
            <p
              role="alert"
              className="rounded-md border border-danger-border
                         bg-danger-subtle px-3 py-2 text-sm text-fg"
            >
              {formError}
            </p>
          )}

          <Field label="Email" htmlFor="email" error={errors.email?.message} required>
            <Input
              type="email"
              autoComplete="username"
              autoFocus
              invalid={Boolean(errors.email)}
              {...register('email')}
            />
          </Field>

          <Field label="Password" htmlFor="password" error={errors.password?.message} required>
            <Input
              type="password"
              autoComplete="current-password"
              invalid={Boolean(errors.password)}
              {...register('password')}
            />
          </Field>

          <Button type="submit" variant="primary" loading={isSubmitting} className="mt-1 w-full">
            Sign in
          </Button>
        </form>

        <p className="mt-5 text-sm text-fg-secondary">
          No account?{' '}
          <Link href="/sign-up" className="text-accent hover:underline">
            Create one
          </Link>
        </p>

        <DemoAccounts />
      </>
    </SignInFrame>
  );
}

/**
 * Seeded demo accounts.
 *
 * Present only outside production, and labelled as local development data.
 * Included because a reviewer opening this repository should be able to sign
 * in as each role in seconds rather than reading the seed script to find the
 * addresses.
 */
function DemoAccounts() {
  if (process.env.NODE_ENV === 'production') return null;

  const accounts = [
    { role: 'Owner', email: 'dana.whitfield@northstar.example' },
    { role: 'Admin', email: 'marcus.oyelaran@northstar.example' },
    { role: 'Member', email: 'priya.raghunathan@northstar.example' },
    { role: 'Viewer', email: 'rosa.delacruz@northstar.example' },
  ];

  return (
    <details className="mt-8 rounded-md border border-border bg-surface text-xs">
      <summary className="cursor-pointer px-3 py-2 text-fg-secondary">
        Demo accounts (local development)
      </summary>
      <div className="border-t border-border px-3 py-2">
        <table className="w-full">
          <tbody>
            {accounts.map((account) => (
              <tr key={account.email}>
                <td className="py-0.5 pr-3 text-fg-tertiary">{account.role}</td>
                <td className="reference py-0.5">{account.email}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="mt-2 text-fg-tertiary">
          Password <span className="reference">atlas-demo-password</span>
        </p>
      </div>
    </details>
  );
}
