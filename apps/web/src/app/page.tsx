import { redirect } from 'next/navigation';

/**
 * The root is a router, not a page.
 *
 * ATLAS is an internal tool; there is no marketing surface to land on. An
 * anonymous visitor goes to sign-in, and the sign-in flow decides where a
 * signed-in user belongs based on what their account can actually reach.
 */
export default function RootPage() {
  redirect('/sign-in');
}
