import { Play, Sparkles } from 'lucide-react';
import { Button } from '@librechat/client';
import type { ReactNode } from 'react';
import type { ViewTurn } from './data';
import { formatDateTime } from './data';
import { useLocalize } from '~/hooks';

type TurnProps = {
  turn: ViewTurn;
  /** Re-runs every chart in this turn; the button is hidden when the turn has no charts */
  onRunAll?: () => void;
  /** The cards this turn generated */
  children: ReactNode;
};

/** One AI Suggest exchange: the user's prompt, the AI overview, then the charts it produced */
export default function Turn({ turn, onRunAll, children }: TurnProps) {
  const localize = useLocalize();

  return (
    <section
      aria-label={localize('com_ui_mcp_views_turn', { 0: turn.prompt })}
      className="space-y-3"
    >
      <div className="flex justify-end">
        <div className="max-w-[80%] rounded-2xl bg-surface-tertiary px-4 py-2 text-sm text-text-primary">
          <p className="whitespace-pre-wrap">{turn.prompt}</p>
          <time
            dateTime={turn.createdAt}
            className="mt-1 block text-right text-xs text-text-secondary"
          >
            {formatDateTime(turn.createdAt)}
          </time>
        </div>
      </div>
      {turn.overview != null && turn.overview !== '' && (
        <div className="flex items-start gap-2 text-sm text-text-primary">
          <Sparkles className="mt-0.5 size-4 shrink-0 text-text-secondary" aria-hidden="true" />
          <p className="whitespace-pre-wrap">{turn.overview}</p>
        </div>
      )}
      {onRunAll != null && (
        <Button
          variant="submit"
          size="sm"
          className="h-8 gap-1.5"
          onClick={onRunAll}
          aria-label={localize('com_ui_mcp_views_run_all')}
        >
          <Play className="size-3.5" aria-hidden="true" />
          {localize('com_ui_mcp_views_run_all')}
        </Button>
      )}
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">{children}</div>
    </section>
  );
}
