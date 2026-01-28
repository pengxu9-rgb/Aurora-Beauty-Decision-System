import { NextResponse } from "next/server";

import { calculateScore } from "@/lib/engine";
import type { UserVector } from "@/types";

import { corsPreflight, withCors } from "../_cors";
import { getSkuById } from "../_lib";

type ScoreRequest = {
  sku_id: string;
  user: UserVector;
};

export async function POST(req: Request) {
  let body: ScoreRequest;
  try {
    body = (await req.json()) as ScoreRequest;
  } catch {
    return withCors(NextResponse.json({ error: "Invalid JSON body" }, { status: 400 }));
  }

  if (!body?.sku_id || !body?.user) {
    return withCors(NextResponse.json({ error: "`sku_id` and `user` are required" }, { status: 400 }));
  }

  const sku = await getSkuById(body.sku_id);
  if (!sku) return withCors(NextResponse.json({ error: "SKU not found" }, { status: 404 }));

  const score = calculateScore(sku, body.user);
  return withCors(NextResponse.json({ sku_id: sku.sku_id, score }));
}

export function OPTIONS() {
  return corsPreflight();
}
