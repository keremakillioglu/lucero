import { useEffect, useId, useRef, useState } from 'react';
import { Button, Input, Label, OGDialog, OGDialogTemplate, Spinner } from '@librechat/client';
import type { FormEvent } from 'react';
import { useLocalize } from '~/hooks';

type SaveDialogProps = {
  open: boolean;
  isSaving: boolean;
  onOpenChange: (open: boolean) => void;
  /** Resolves true when the view was saved, which closes the dialog */
  onSave: (name: string) => Promise<boolean>;
};

const MAX_NAME_LENGTH = 120;

export default function SaveDialog({ open, isSaving, onOpenChange, onSave }: SaveDialogProps) {
  const localize = useLocalize();
  const formId = useId();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [name, setName] = useState('');

  useEffect(() => {
    if (!open) {
      return;
    }
    const frameId = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(frameId);
  }, [open]);

  const handleOpenChange = (nextOpen: boolean) => {
    onOpenChange(nextOpen);
    if (!nextOpen) {
      setName('');
    }
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed || isSaving) {
      return;
    }
    if (await onSave(trimmed)) {
      handleOpenChange(false);
    }
  };

  return (
    <OGDialog open={open} onOpenChange={handleOpenChange}>
      <OGDialogTemplate
        title={localize('com_ui_mcp_views_save_as')}
        showCloseButton={true}
        className="w-11/12 max-w-lg bg-surface-primary text-text-primary"
        main={
          <form id={formId} onSubmit={handleSubmit} className="space-y-2">
            <Label htmlFor={`${formId}-name`} className="text-sm font-medium text-text-primary">
              {localize('com_ui_mcp_views_name')}
            </Label>
            <Input
              id={`${formId}-name`}
              ref={inputRef}
              value={name}
              maxLength={MAX_NAME_LENGTH}
              onChange={(event) => setName(event.target.value)}
              placeholder={localize('com_ui_mcp_views_name_placeholder')}
              className="w-full bg-transparent text-text-primary placeholder:text-text-secondary focus-visible:ring-2 focus-visible:ring-ring-primary"
            />
          </form>
        }
        buttons={
          <Button
            type="submit"
            form={formId}
            variant="submit"
            disabled={!name.trim() || isSaving}
            aria-label={localize('com_ui_save')}
          >
            {isSaving ? <Spinner className="size-4" /> : localize('com_ui_save')}
          </Button>
        }
      />
    </OGDialog>
  );
}
