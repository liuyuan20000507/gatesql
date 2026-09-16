import Link from "next/link";

/** 全站顶栏：品牌印记 + 两处导航。衬线字仅用于品牌名，导航用正文黑体。 */
export function SiteHeader() {
  return (
    <header className="sticky top-0 z-10 border-b border-border bg-card/85 backdrop-blur">
      <div className="mx-auto flex max-w-3xl items-center justify-between px-4 py-3">
        <Link href="/" className="flex items-center gap-2.5">
          <span
            aria-hidden
            className="font-serif-sc inline-flex h-7 w-7 items-center justify-center rounded-sm bg-primary text-sm font-bold text-primary-foreground"
          >
            口
          </span>
          <span className="font-serif-sc text-lg font-bold tracking-wide text-foreground">Caliber</span>
          <span className="hidden text-xs text-muted-foreground sm:inline">口径台账</span>
        </Link>
        <nav className="flex items-center gap-4 text-sm text-muted-foreground">
          <Link href="/" className="hover:text-foreground">
            问答
          </Link>
          <Link href="/reports" className="hover:text-foreground">
            固化报表
          </Link>
        </nav>
      </div>
    </header>
  );
}
