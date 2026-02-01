import { SkinIdentityCard } from "@/components/chat/SkinIdentityCard";

export default function SkinIdentityUiPage() {
  return (
    <main className="min-h-screen bg-gradient-to-b from-white via-slate-50 to-slate-100 px-4 py-8">
      <div className="mx-auto w-full max-w-sm space-y-4">
        <div className="rounded-2xl border border-slate-200 bg-white/80 p-4 backdrop-blur">
          <div className="text-sm font-semibold text-slate-900">SkinIdentityCard</div>
          <div className="mt-1 text-xs text-slate-500">UI preview (clinical luxury)</div>
        </div>

        <SkinIdentityCard
          status="good"
          resilienceScore={86}
          hydration={62}
          sebum={48}
          sensitivity={24}
          concerns={["Occasional breakouts", "Texture", "Dark spots"]}
        />

        <SkinIdentityCard
          status="attention"
          resilienceScore={58}
          hydration={28}
          sebum={86}
          sensitivity={72}
          concerns={["Stinging", "Redness", "Acne flare-ups"]}
        />
      </div>
    </main>
  );
}

