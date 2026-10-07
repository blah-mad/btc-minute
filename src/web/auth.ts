import { createAuthClient } from 'better-auth/react';
import { anonymousClient } from 'better-auth/client/plugins';

export const authClient = createAuthClient({
  basePath: '/api/auth',
  plugins: [anonymousClient()],
});

let guestRequest: Promise<void> | null = null;

/** Share the first guest request across renders and React's development checks. */
export function ensureGuestSession(): Promise<void> {
  if (!guestRequest) {
    guestRequest = authClient.signIn.anonymous().then(({ error }) => {
      if (error) throw new Error(error.message || 'Your guest session could not be started.');
    }).finally(() => { guestRequest = null; });
  }
  return guestRequest;
}
