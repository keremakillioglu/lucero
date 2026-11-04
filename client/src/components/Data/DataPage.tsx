import { Database, ExternalLink } from 'lucide-react';
import { useLocalize } from '~/hooks';

/** Entry route of the DuckDB UI, served through the dev server's proxy so it can be framed */
const DUCKDB_UI_PATH = '/welcome';

/** Frames the warehouse's DuckDB UI (tables, columns, ad-hoc SQL); dev server only */
export default function DataPage() {
  const localize = useLocalize();

  return (
    <div className="flex h-full w-full flex-col bg-presentation">
      <div className="mx-auto flex h-full w-full max-w-7xl flex-1 flex-col px-4 py-6">
        <div className="mb-4 flex items-start justify-between gap-4">
          <div>
            <h1 className="flex items-center gap-2 text-xl font-semibold text-text-primary">
              <Database className="size-5" aria-hidden="true" />
              {localize('com_ui_data_explorer')}
            </h1>
            <p className="mt-1 text-sm text-text-secondary">
              {localize('com_ui_data_explorer_description')}
            </p>
          </div>
          {import.meta.env.DEV && (
            <a
              href={DUCKDB_UI_PATH}
              target="_blank"
              rel="noreferrer"
              className="flex h-9 shrink-0 items-center gap-1.5 rounded-lg border border-border-light px-3 text-sm text-text-primary hover:bg-surface-secondary"
            >
              <ExternalLink className="size-4" aria-hidden="true" />
              {localize('com_ui_data_explorer_open')}
            </a>
          )}
        </div>
        {import.meta.env.DEV ? (
          <iframe
            src={DUCKDB_UI_PATH}
            title={localize('com_ui_data_explorer')}
            className="min-h-0 w-full flex-1 rounded-xl border border-border-light bg-surface-primary"
          />
        ) : (
          <p className="py-8 text-center text-sm text-text-secondary">
            {localize('com_ui_data_explorer_dev_only')}
          </p>
        )}
      </div>
    </div>
  );
}
