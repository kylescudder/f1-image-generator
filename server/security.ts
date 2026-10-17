import type { Request, Response, NextFunction } from "express";

// Identity comes only from Clerk's cryptographically verified getAuth result.
export function ownerDecision(
  identity: { userId: string | null; isAuthenticated?: boolean },
  ownerId: string,
): 200 | 401 | 403 | 503 {
  if (!ownerId) return 503;
  if (!identity.isAuthenticated || !identity.userId) return 401;
  return identity.userId === ownerId ? 200 : 403;
}
export function sameOrigin(origin: string) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
    if (req.headers.origin !== origin) {
      res
        .status(403)
        .json({ error: "This request must come from your own Paddock site." });
      return;
    }
    next();
  };
}
