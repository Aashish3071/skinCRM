"use client";

import { ErrorScreen } from "@/components/error-screen";

export default function Error(props: { error: Error & { digest?: string }; reset: () => void }) {
  return <ErrorScreen {...props} />;
}
