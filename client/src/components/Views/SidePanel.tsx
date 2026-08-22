import { useLocalize } from '~/hooks';

/**
 * Intentionally minimal: exists so the Views nav icon has drawer content and
 * consistent toggle/highlight behavior. The full panel (add view, saved-view
 * list, sources) was removed pending a redesign — see commit 3d7c8b833.
 */
export default function ViewsSidePanel() {
  const localize = useLocalize();

  return (
    <div className="flex h-auto w-full flex-col px-3 pb-3 pt-2">
      <div role="region" aria-label={localize('com_ui_mcp_views')} className="space-y-2">
        <p className="px-1 text-sm text-text-secondary">
          {localize('com_ui_mcp_views_description')}
        </p>
      </div>
    </div>
  );
}
