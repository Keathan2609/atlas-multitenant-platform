'use client';

import * as React from 'react';
import * as RadixDialog from '@radix-ui/react-dialog';
import { Button, Input, cx } from './primitives';

/**
 * Dialogs.
 *
 * Built on Radix primitives for the behaviour that is genuinely hard to get
 * right by hand — focus trapping, focus restoration on close, `aria-modal`,
 * escape and outside-click, and inerting the rest of the page — and styled
 * entirely from ATLAS tokens so none of the library's default appearance shows
 * through.
 *
 * Used sparingly. A dialog is for a focused task with a clear commit point:
 * inviting someone, creating a key, confirming something destructive. Anything
 * with substantial content gets its own route instead, because a form that
 * needs scrolling inside a modal is a page wearing the wrong clothes.
 */

export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  width = 'md',
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
  width?: 'sm' | 'md';
}) {
  const returnFocusTo = useReturnFocus(open);

  return (
    <RadixDialog.Root open={open} onOpenChange={onOpenChange}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="fixed inset-0 z-50 bg-black/40" />
        <RadixDialog.Content
          onCloseAutoFocus={(event) => {
            // Radix restores focus to its own Trigger, and these dialogs are
            // opened from ordinary buttons and row menus holding state — so
            // without this, closing drops focus on <body> and the next Tab
            // starts again from the top of the page.
            const target = returnFocusTo.current;
            if (target && document.contains(target)) {
              event.preventDefault();
              target.focus();
            }
          }}
          className={cx(
            'fixed left-1/2 top-1/2 z-50 w-[calc(100vw-2rem)] -translate-x-1/2 -translate-y-1/2',
            'rounded-lg border border-border bg-surface-raised shadow-dialog',
            'max-h-[calc(100dvh-4rem)] overflow-y-auto',
            width === 'sm' ? 'max-w-[380px]' : 'max-w-[440px]',
          )}
        >
          <div className="border-b border-border px-4 py-3">
            <RadixDialog.Title className="text-base font-semibold text-fg">
              {title}
            </RadixDialog.Title>
            {description && (
              // Radix wires this to aria-describedby automatically.
              <RadixDialog.Description className="mt-1 text-sm leading-relaxed text-fg-secondary">
                {description}
              </RadixDialog.Description>
            )}
          </div>

          <div className="px-4 py-4">{children}</div>

          {footer && (
            <div className="flex justify-end gap-2 border-t border-border px-4 py-3">{footer}</div>
          )}
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}

export const DialogClose = RadixDialog.Close;

/**
 * Remembers what to give focus back to when a dialog closes.
 *
 * Tracked from a `focusin` listener rather than read when `open` flips,
 * because by the time an effect runs the focus scope has already moved focus
 * inside the dialog. Anything within a dialog is ignored, so the value is
 * always the last control outside one — which is what opened it.
 */
function useReturnFocus(open: boolean): React.RefObject<HTMLElement | null> {
  const lastOutside = React.useRef<HTMLElement | null>(null);
  const captured = React.useRef<HTMLElement | null>(null);

  React.useEffect(() => {
    function onFocusIn(event: FocusEvent) {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      if (target.closest('[role="dialog"]')) return;
      lastOutside.current = target;
    }
    document.addEventListener('focusin', onFocusIn, true);
    return () => document.removeEventListener('focusin', onFocusIn, true);
  }, []);

  React.useEffect(() => {
    if (open) captured.current = lastOutside.current;
  }, [open]);

  return captured;
}

/**
 * Destructive confirmation.
 *
 * Two levels, chosen by whether `confirmText` is supplied:
 *
 *  - Without it, a plain confirm. Enough for something recoverable.
 *  - With it, the user must retype an exact value — the organization slug, a
 *    project key. The same string is validated again on the server, so this is
 *    not the security control; it is what stops a mis-click destroying
 *    something that cannot be restored.
 *
 * Never optimistic. The dialog stays open with the button in its pending state
 * until the server confirms, because showing a deletion as done before it is
 * done is worse than a moment of waiting.
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  confirmText,
  confirmTextLabel,
  onConfirm,
  pending,
  error,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  confirmLabel: string;
  confirmText?: string;
  confirmTextLabel?: string;
  onConfirm: () => void;
  pending?: boolean;
  error?: string;
}) {
  const [typed, setTyped] = React.useState('');
  const inputId = React.useId();

  // Clears the typed value whenever the dialog opens, so a previous attempt
  // cannot leave the button armed.
  React.useEffect(() => {
    if (open) setTyped('');
  }, [open]);

  const armed = !confirmText || typed === confirmText;

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      description={description}
      width="sm"
      footer={
        <>
          <DialogClose asChild>
            <Button variant="secondary" disabled={pending}>
              Cancel
            </Button>
          </DialogClose>
          <Button variant="danger" onClick={onConfirm} disabled={!armed} loading={pending}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      {confirmText && (
        <div className="flex flex-col gap-1.5">
          <label htmlFor={inputId} className="text-xs font-medium text-fg">
            {confirmTextLabel ?? 'Type the name to confirm'}{' '}
            <span className="reference text-fg-secondary">{confirmText}</span>
          </label>
          <Input
            id={inputId}
            value={typed}
            onChange={(event) => setTyped(event.target.value)}
            autoComplete="off"
            spellCheck={false}
          />
        </div>
      )}

      {error && (
        <p role="alert" className="mt-3 text-sm text-danger">
          {error}
        </p>
      )}
    </Dialog>
  );
}
