import Link from 'next/link';
import { getCandidate } from '@/lib/auth';
import LogoutButton from './LogoutButton';

export default async function SiteHeader() {
  const cand = await getCandidate();
  return (
    <header className="border-b border-slate-200 bg-white">
      <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3">
        <Link href="/" className="flex items-baseline gap-2">
          <span className="font-serif text-2xl font-bold tracking-tight text-brand-800">Best Wishes</span>
          <span className="hidden text-sm text-slate-500 sm:inline">Mock tests on a real clock</span>
        </Link>
        {cand && (
          <nav className="flex items-center gap-5 text-sm">
            <Link href="/" className="font-medium text-slate-700 hover:text-brand-700">Today&apos;s tests</Link>
            <Link href="/my-results" className="font-medium text-slate-700 hover:text-brand-700">My results</Link>
            <Link href="/leaderboard" className="font-medium text-slate-700 hover:text-brand-700">Results board</Link>
            <span className="hidden text-slate-400 sm:inline">|</span>
            <span className="hidden text-slate-600 sm:inline">{cand.name}</span>
            <LogoutButton endpoint="/api/logout" redirectTo="/" />
          </nav>
        )}
      </div>
    </header>
  );
}
