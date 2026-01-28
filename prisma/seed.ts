import "dotenv/config";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function recreateProductByIdentity(data: Parameters<typeof prisma.product.create>[0]["data"]) {
  const brand = data.brand;
  const name = data.name;

  const existing = await prisma.product.findFirst({
    where: { brand, name },
    select: { id: true },
  });

  if (existing) {
    await prisma.product.delete({ where: { id: existing.id } });
  }

  return prisma.product.create({ data });
}

async function main() {
  console.log("🌱 Starting Aurora seed...");

  // 1) Tom Ford Research Serum (Anchor)
  const tf = await recreateProductByIdentity({
    brand: "Tom Ford",
    name: "Research Serum Concentrate",
    priceUsd: "350.00",
    priceCny: "2800.00",
    productUrl: "https://www.tomfordbeauty.com/...",
    ingredients: {
      create: {
        fullList: ["Water", "Caffeine", "Theobroma Cacao", "Glycolic Acid", "Alcohol Denat"],
        heroActives: [
          { name: "Caffeine", role: "Depuffing" },
          { name: "Glycolic Acid", role: "Exfoliation" },
        ],
      },
    },
    vectors: {
      create: {
        mechanism: {
          oil_control: 90,
          anti_aging: 70,
          soothing: 20,
          barrier_repair: 30,
        },
        experience: {
          texture: "gel_serum",
          finish: "matte",
          pilling_risk: 0.2,
        },
        riskFlags: ["alcohol_high", "acid_medium"],
      },
    },
    socialStats: {
      create: {
        redScore: 65,
        redditScore: 90,
        burnRate: "0.15",
        topKeywords: ["哑光", "控油牛", "酒精味", "刺痛"],
      },
    },
  });

  // 2) The Ordinary Copper Peptides (Dupe)
  const to = await recreateProductByIdentity({
    brand: "The Ordinary",
    name: "Buffet + Copper Peptides 1%",
    priceUsd: "30.00",
    priceCny: "240.00",
    ingredients: {
      create: {
        fullList: ["Water", "Glycerin", "Copper Tripeptide-1", "Lactococcus Ferment"],
        heroActives: [{ name: "Copper Peptide", role: "Repair" }],
      },
    },
    vectors: {
      create: {
        mechanism: {
          oil_control: 40,
          anti_aging: 85,
          soothing: 90,
          barrier_repair: 95,
        },
        experience: {
          texture: "sticky_gel",
          finish: "dewy",
          pilling_risk: 0.6,
        },
        riskFlags: ["texture_sticky"],
      },
    },
    socialStats: {
      create: {
        redScore: 88,
        redditScore: 92,
        burnRate: "0.01",
        topKeywords: ["修护神", "粘腻", "蓝铜"],
      },
    },
  });

  // 3) 赫莲娜黑绷带（Helena Rubinstein Black Bandage）
  const hr = await recreateProductByIdentity({
    brand: "Helena Rubinstein",
    name: "Re-Plasty Age Recovery Night Cream (Black Bandage)",
    priceUsd: "460.00",
    priceCny: "3900.00",
    productUrl: "https://www.helenarubinstein.com/...",
    ingredients: {
      create: {
        fullList: ["Water", "Glycerin", "Shea Butter", "Dimethicone", "Madecassoside", "Fragrance"],
        heroActives: [
          { name: "Madecassoside", role: "Soothing / Repair" },
          { name: "Occlusives", role: "Barrier support" },
        ],
      },
    },
    vectors: {
      create: {
        mechanism: {
          oil_control: 10,
          anti_aging: 75,
          soothing: 80,
          barrier_repair: 90,
        },
        experience: {
          texture: "thick_cream",
          finish: "dewy",
          pilling_risk: 0.25,
        },
        riskFlags: ["fragrance", "occlusive_heavy"],
      },
    },
    socialStats: {
      create: {
        redScore: 92,
        redditScore: 68,
        burnRate: "0.04",
        topKeywords: ["修护", "厚重", "贵", "滋润"],
      },
    },
  });

  console.log(`✅ Seeded: ${tf.brand} - ${tf.name}`);
  console.log(`✅ Seeded: ${to.brand} - ${to.name}`);
  console.log(`✅ Seeded: ${hr.brand} - ${hr.name}`);
}

main()
  .catch((e) => {
    console.error("❌ Seed failed:", e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

