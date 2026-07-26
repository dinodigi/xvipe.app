import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "XVibe — studio",
  description: "Describe an app. The builder ships it — backend on Pluggie, frontend live on the edge.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
