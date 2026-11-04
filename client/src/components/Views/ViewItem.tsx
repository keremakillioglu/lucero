import { useState } from 'react';
import { Check, Pencil, Trash2, LayoutDashboard } from 'lucide-react';
import { Button, TooltipAnchor } from '@librechat/client';
import type { FormEvent, KeyboardEvent } from 'react';
import type { TSavedView } from 'librechat-data-provider';
import { useLocalize } from '~/hooks';
import { cn } from '~/utils';

type ViewItemProps = {
  view: TSavedView;
  isActive: boolean;
  onOpen: (view: TSavedView) => void;
  onRename: (id: string, name: string) => void;
  onDelete: (id: string) => void;
};

const MAX_NAME_LENGTH = 120;

const focusOnMount = (element: HTMLElement | null) => element?.focus();

/** One saved view in the left bar: open it, rename it inline, or delete it after a confirm */
export default function ViewItem({ view, isActive, onOpen, onRename, onDelete }: ViewItemProps) {
  const localize = useLocalize();
  const [draftName, setDraftName] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const startRename = () => setDraftName(view.name);

  const finishRename = () => {
    if (draftName != null) {
      onRename(view._id, draftName);
    }
    setDraftName(null);
  };

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    finishRename();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape') {
      setDraftName(null);
    }
  };

  const confirmDelete = () => {
    setConfirmingDelete(false);
    onDelete(view._id);
  };

  if (draftName != null) {
    return (
      <form role="listitem" onSubmit={handleSubmit} className="flex items-center gap-1 px-1 py-1">
        <input
          ref={focusOnMount}
          value={draftName}
          maxLength={MAX_NAME_LENGTH}
          onChange={(event) => setDraftName(event.target.value)}
          onKeyDown={handleKeyDown}
          onBlur={finishRename}
          aria-label={localize('com_ui_mcp_views_name')}
          className="h-8 min-w-0 flex-1 rounded-md border border-border-medium bg-surface-primary px-2 text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-ring-primary"
        />
      </form>
    );
  }

  return (
    <div
      role="listitem"
      className={cn(
        'group flex items-center gap-1 rounded-lg hover:bg-surface-secondary',
        isActive && 'bg-surface-active-alt',
      )}
    >
      <button
        type="button"
        onClick={() => onOpen(view)}
        onDoubleClick={startRename}
        aria-current={isActive ? 'page' : undefined}
        className="flex min-w-0 flex-1 items-center gap-2 rounded-lg px-2 py-2 text-left"
      >
        <LayoutDashboard className="size-4 shrink-0 text-text-secondary" aria-hidden="true" />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm text-text-primary">{view.name}</span>
          <span className="block truncate text-xs text-text-secondary">
            {localize('com_ui_mcp_views_card_count', { 0: String(view.cards.length) })}
          </span>
        </span>
      </button>
      {confirmingDelete ? (
        <Button
          ref={focusOnMount}
          variant="ghost"
          size="icon"
          className="size-8 shrink-0 text-red-500"
          onClick={confirmDelete}
          onBlur={() => setConfirmingDelete(false)}
          aria-label={localize('com_ui_mcp_views_delete_confirm', { 0: view.name })}
        >
          <Check className="size-4" aria-hidden="true" />
        </Button>
      ) : (
        <>
          <TooltipAnchor
            description={localize('com_ui_rename')}
            side="bottom"
            render={
              <Button
                variant="ghost"
                size="icon"
                className="size-8 shrink-0 text-text-secondary opacity-0 hover:text-text-primary focus-visible:opacity-100 group-hover:opacity-100"
                onClick={startRename}
                aria-label={localize('com_ui_mcp_views_rename', { 0: view.name })}
              >
                <Pencil className="size-4" aria-hidden="true" />
              </Button>
            }
          />
          <TooltipAnchor
            description={localize('com_ui_delete')}
            side="bottom"
            render={
              <Button
                variant="ghost"
                size="icon"
                className="size-8 shrink-0 text-text-secondary opacity-0 hover:text-red-500 focus-visible:opacity-100 group-hover:opacity-100"
                onClick={() => setConfirmingDelete(true)}
                aria-label={localize('com_ui_mcp_views_delete', { 0: view.name })}
              >
                <Trash2 className="size-4" aria-hidden="true" />
              </Button>
            }
          />
        </>
      )}
    </div>
  );
}
