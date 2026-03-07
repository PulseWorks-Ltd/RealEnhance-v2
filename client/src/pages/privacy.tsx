export default function PrivacyPage() {
  return (
    <div className="bg-slate-50">
      <div className="mx-auto w-full max-w-4xl px-4 py-10 sm:px-6 lg:px-8 lg:py-12">
        <article className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm sm:p-8 lg:p-10">
          <header className="mb-8 space-y-2">
            <h1 className="text-3xl font-bold tracking-tight text-slate-900 sm:text-4xl">Privacy Policy (Draft)</h1>
            <p className="text-sm text-slate-600">Effective Date: 9 March 2026</p>
            <p className="text-slate-700">
              RealEnhance respects your privacy and is committed to protecting your personal information.
            </p>
          </header>

          <div className="space-y-8 text-slate-700">
            <section className="space-y-3">
              <h2 className="text-xl font-semibold text-slate-900">Information We Collect</h2>
              <p>When you use RealEnhance, we may collect:</p>
              <ul className="list-disc space-y-2 pl-6">
                <li>account information (name, email)</li>
                <li>uploaded images</li>
                <li>usage data related to image processing</li>
                <li>billing and subscription information</li>
              </ul>
            </section>

            <section className="space-y-3">
              <h2 className="text-xl font-semibold text-slate-900">How We Use Information</h2>
              <p>We use collected information to:</p>
              <ul className="list-disc space-y-2 pl-6">
                <li>provide the RealEnhance service</li>
                <li>process uploaded images</li>
                <li>manage accounts and subscriptions</li>
                <li>improve system performance</li>
                <li>communicate service updates</li>
              </ul>
              <p>Uploaded images are processed only for the purpose of delivering the Service.</p>
            </section>

            <section className="space-y-3">
              <h2 className="text-xl font-semibold text-slate-900">Data Storage</h2>
              <p>Images and related data may be stored temporarily to allow processing and user downloads.</p>
              <p>RealEnhance takes reasonable measures to protect stored data from unauthorized access.</p>
            </section>

            <section className="space-y-3">
              <h2 className="text-xl font-semibold text-slate-900">Third-Party Services</h2>
              <p>
                RealEnhance may use third-party infrastructure providers, payment processors, and AI services to
                operate the platform.
              </p>
              <p>These providers may process data only as necessary to provide their services.</p>
            </section>

            <section className="space-y-3">
              <h2 className="text-xl font-semibold text-slate-900">User Rights</h2>
              <p>
                Users may request deletion of their account and associated personal data by contacting RealEnhance.
              </p>
            </section>

            <section className="space-y-3">
              <h2 className="text-xl font-semibold text-slate-900">Changes to this Policy</h2>
              <p>This Privacy Policy may be updated periodically.</p>
              <p>Continued use of the Service constitutes acceptance of the updated policy.</p>
            </section>
          </div>
        </article>
      </div>
    </div>
  );
}
