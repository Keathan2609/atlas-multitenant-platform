import { AppShell } from '@/components/app-shell';

export default async function TenantLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ orgSlug: string }>;
}) {
  const { orgSlug } = await params;
  return <AppShell slug={orgSlug}>{children}</AppShell>;
}
