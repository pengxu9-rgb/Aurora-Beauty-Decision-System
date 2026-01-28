import { ConsultWizard } from "@/components/consult/ConsultWizard";

export default function ConsultPage() {
  return (
    <main className="min-h-screen bg-gradient-to-b from-white via-slate-50 to-slate-100 px-4 py-8">
      <div className="mx-auto w-full max-w-sm">
        <ConsultWizard />
      </div>
    </main>
  );
}

