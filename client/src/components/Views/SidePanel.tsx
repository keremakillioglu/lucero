import { useNavigate } from 'react-router-dom';
import { Plus } from 'lucide-react';
import { Button, Spinner } from '@librechat/client';
import type { TSavedView } from 'librechat-data-provider';
import { useLocalize } from '~/hooks';
import useSavedViews from './saved';
import ViewItem from './ViewItem';
import { viewPath } from './route';

/** Saved views for the left bar: start a new view, or open, rename or delete a saved one */
export default function ViewsSidePanel() {
  const localize = useLocalize();
  const navigate = useNavigate();
  const { savedViews, isLoading, activeView, startNewView, renameView, removeView } =
    useSavedViews();

  const openView = (view: TSavedView) => navigate(viewPath(view._id));

  const openNewView = () => {
    startNewView();
    navigate(viewPath(null));
  };

  return (
    <div className="flex h-auto w-full flex-col px-3 pb-3 pt-2">
      <div role="region" aria-label={localize('com_ui_mcp_views_saved_list')} className="space-y-3">
        <Button
          size="sm"
          variant="outline"
          className="h-9 w-full gap-2 rounded-lg border-border-light font-medium"
          onClick={openNewView}
          aria-label={localize('com_ui_mcp_views_new')}
        >
          <Plus className="size-4" aria-hidden="true" />
          {localize('com_ui_mcp_views_new')}
        </Button>

        {isLoading && (
          <div className="flex justify-center py-2">
            <Spinner className="size-4" />
          </div>
        )}

        {!isLoading && savedViews.length === 0 && (
          <p className="px-1 py-2 text-xs text-text-secondary">
            {localize('com_ui_mcp_views_saved_empty')}
          </p>
        )}

        {savedViews.length > 0 && (
          <div
            role="list"
            aria-label={localize('com_ui_mcp_views_saved_list')}
            className="space-y-1"
          >
            {savedViews.map((view) => (
              <ViewItem
                key={view._id}
                view={view}
                isActive={view._id === activeView?._id}
                onOpen={openView}
                onRename={renameView}
                onDelete={removeView}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
