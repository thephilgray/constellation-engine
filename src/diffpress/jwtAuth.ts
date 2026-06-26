import { CognitoJwtVerifier } from "aws-jwt-verify";
import { Resource } from "sst";
import type { APIGatewayProxyEventV2 } from "aws-lambda";

/** Pull a bearer token out of Function URL headers (header casing varies). */
export function extractBearer(headers: Record<string, string | undefined>): string {
  const raw = headers.authorization ?? headers.Authorization ?? "";
  const m = /^Bearer\s+(.+)$/.exec(raw);
  if (!m) throw new Error("unauthorized");
  return m[1];
}

// Lazy singleton — building the verifier fetches the JWKS once and caches it.
let verifier: ReturnType<typeof CognitoJwtVerifier.create> | undefined;
function getVerifier() {
  if (!verifier) {
    verifier = CognitoJwtVerifier.create({
      userPoolId: (Resource as any).UserPoolId.value,
      tokenUse: "id",
      clientId: (Resource as any).WebClientId.value,
    });
  }
  return verifier;
}

/** Verify the Cognito id token on a Function URL event; return the user `sub`. */
export async function verifyJwt(event: APIGatewayProxyEventV2): Promise<string> {
  const token = extractBearer(event.headers ?? {});
  const payload = await getVerifier().verify(token);
  return payload.sub;
}
