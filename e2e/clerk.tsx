// External identity boundary for the isolated browser fixture only.
import type { ReactNode } from "react";
export const ClerkProvider = ({ children }: { children: ReactNode }) =>
  children;
export const useAuth = () => ({ isLoaded: true, isSignedIn: true });
export const UserButton = () => null;
export const SignIn = () => null;
