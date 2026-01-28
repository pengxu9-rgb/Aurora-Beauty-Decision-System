import { NextResponse } from "next/server";

import { corsPreflight, withCors } from "../_cors";
import { getSkuDatabase } from "../_lib";

export async function GET() {
  const skus = await getSkuDatabase();
  return withCors(NextResponse.json({ skus }));
}

export function OPTIONS() {
  return corsPreflight();
}

