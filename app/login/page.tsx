import { LoginForm } from './_components/login-form'

type Props = {
  searchParams: Promise<{ from?: string }>
}

export default async function LoginPage({ searchParams }: Props) {
  const sp = await searchParams
  return (
    <div className="flex min-h-screen items-center justify-center bg-[color:var(--color-bg-secondary)] px-4 py-10">
      <div className="w-full max-w-sm rounded-lg border border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)] p-6 shadow-sm">
        <h1 className="text-[16px] font-semibold text-[color:var(--color-text-primary)]">
          Sign in
        </h1>
        <p className="mt-1 text-[12px] text-[color:var(--color-text-secondary)]">
          Rooster Partners internal dashboard.
        </p>
        <div className="mt-4">
          <LoginForm redirectTo={sp.from ?? ''} />
        </div>
      </div>
    </div>
  )
}
