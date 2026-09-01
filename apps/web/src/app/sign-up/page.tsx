'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { registerSchema, type RegisterInput } from '@atlas/validation';
import { ApiError, api, applyFieldErrors } from '@/lib/api';
import { Button, Field, Input } from '@/components/ui/primitives';
import { describeError } from '@/components/ui/states';

/**
 * Create an account.
 *
 * The same single column as sign-in, three fields, no marketing. A new account
 * belongs to no organization yet, so it always lands on onboarding — there is
 * nothing else it could usefully be shown.
 */
export default function SignUpPage() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [formError, setFormError] = React.useState<string | null>(null);

  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<RegisterInput>({
    resolver: zodResolver(registerSchema),
    defaultValues: { email: '', password: '', displayName: '' },
  });

  async function onSubmit(values: RegisterInput) {
    setFormError(null);
    try {
      await api.post('/auth/register', values);
      // Same reasoning as sign-in: registering while another account's session
      // was open must not leave that account's cached data on screen.
      queryClient.clear();
      router.replace('/onboarding');
    } catch (error) {
      // The server puts "this email address is already registered" on the
      // email field, which is where it belongs — registration is the one flow
      // where that fact has to be disclosed for the person to proceed.
      if (!applyFieldErrors(error, setError as never)) {
        if (error instanceof ApiError && error.status === 429) {
          setFormError('Too many accounts have been created from here recently. Try again later.');
        } else {
          setFormError(describeError(error).description);
        }
      }
    }
  }

  return (
    <main className="flex min-h-dvh flex-col items-center justify-center bg-canvas px-4 py-10">
      <div className="w-full max-w-[352px]">
        <div className="mb-7">
          <p className="reference text-base font-medium tracking-tight text-fg">ATLAS</p>
          <h1 className="mt-4 text-lg font-semibold text-fg">Create an account</h1>
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

          <Field
            label="Name"
            htmlFor="displayName"
            description="How colleagues will see you."
            error={errors.displayName?.message}
            required
          >
            <Input
              autoComplete="name"
              autoFocus
              invalid={Boolean(errors.displayName)}
              {...register('displayName')}
            />
          </Field>

          <Field label="Email" htmlFor="email" error={errors.email?.message} required>
            <Input
              type="email"
              autoComplete="username"
              invalid={Boolean(errors.email)}
              {...register('email')}
            />
          </Field>

          <Field
            label="Password"
            htmlFor="password"
            description="At least 12 characters."
            error={errors.password?.message}
            required
          >
            <Input
              type="password"
              autoComplete="new-password"
              invalid={Boolean(errors.password)}
              {...register('password')}
            />
          </Field>

          <Button type="submit" variant="primary" loading={isSubmitting} className="mt-1 w-full">
            Create account
          </Button>
        </form>

        <p className="mt-5 text-sm text-fg-secondary">
          Already have an account?{' '}
          <Link href="/sign-in" className="text-accent hover:underline">
            Sign in
          </Link>
        </p>
      </div>
    </main>
  );
}
