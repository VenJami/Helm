import type { Profile } from './types';

// Display name for an account. Named profiles use their own name. The default
// account has no name of its own, so:
//   1. if a named profile is logged into the same email, reuse that profile's
//      name (the account the user already labeled) — "auto change to existing
//      profile";
//   2. else derive a name from the email's local part (profile1@… → "Profile1");
//   3. else "Default" (before it has been logged in — no email yet).
export function accountLabel(name: string, email: string | null, profiles: Profile[] = []): string {
  if (name) return name;
  if (email) {
    const match = profiles.find((p) => p.email === email);
    if (match) return match.name;
    const local = email.split('@')[0];
    return local.charAt(0).toUpperCase() + local.slice(1);
  }
  return 'Default';
}
