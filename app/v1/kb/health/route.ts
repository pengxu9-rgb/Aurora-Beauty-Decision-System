import { NextResponse } from "next/server";

import { ingredientKbHealthV1 } from "@/lib/ingredient-research-kb";

import { corsPreflight, withCors } from "../../decision/_cors";

export async function GET() {
  const health = await ingredientKbHealthV1();
  return withCors(NextResponse.json({ ok: true, ...health }));
}

export function OPTIONS() {
  return corsPreflight();
}

