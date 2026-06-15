// Shared helper for calling JWT-protected IngestApi routes from the browser.
// Importing this module also runs Amplify.configure (side-effect of ./amplify),
// so callers don't need to import the config separately.
import { fetchAuthSession } from "aws-amplify/auth";
import { API_URL } from "./amplify";

/**
 * Fetch a path on the API with the Cognito id token attached as a Bearer token.
 * Mirrors the inline pattern used in DashboardViewer / ChatContainer.
 */
export async function authedFetch(
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const session = await fetchAuthSession();
  const token = session.tokens?.idToken?.toString();
  if (!token) throw new Error("Not authenticated");
  return fetch(`${API_URL}${path}`, {
    ...init,
    headers: { ...init.headers, Authorization: `Bearer ${token}` },
  });
}
