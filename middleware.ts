import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

const CHATBOX_HOSTS = new Set(["pivota-aurora-chatbox.vercel.app", "aurora.pivota.cc"]);

function isChatboxHost(host: string) {
  const normalized = host.toLowerCase().split(":")[0] ?? "";
  return CHATBOX_HOSTS.has(normalized);
}

export function middleware(request: NextRequest) {
  const host = request.headers.get("host") ?? "";
  if (!isChatboxHost(host)) return NextResponse.next();

  if (request.nextUrl.pathname !== "/") return NextResponse.next();

  const url = request.nextUrl.clone();
  url.pathname = "/chat";
  return NextResponse.rewrite(url);
}

export const config = {
  matcher: ["/"],
};
