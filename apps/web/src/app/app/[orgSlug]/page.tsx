'use client';

import { PageBody, PageHeader, useTenant } from '@/components/app-shell';

export default function OverviewPage() {
  const tenant = useTenant();
  return (
    <>
      <PageHeader title="Overview" />
      <PageBody>
        <p className="text-fg-secondary">{tenant.organization.name}</p>
      </PageBody>
    </>
  );
}
