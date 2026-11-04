import { useCallback, useEffect, useRef, useState } from 'react';
import { SSE } from 'sse.js';
import { mcpViewsSuggest } from 'librechat-data-provider';
import type {
  MCPSuggestedView,
  MCPViewsSuggestEvent,
  MCPViewsSuggestParams,
} from 'librechat-data-provider';
import { useAuthContext } from '~/hooks/AuthContext';

export type SuggestProgress = Extract<MCPViewsSuggestEvent, { type: 'thinking' | 'tool' }>;

type SuggestHandlers = {
  onResult: (views: MCPSuggestedView[], notes?: string) => void;
  onError: (message?: string) => void;
};

/** Streams view suggestions from the server, exposing the model's current step as progress */
export default function useSuggestViews({ onResult, onError }: SuggestHandlers) {
  const { token } = useAuthContext();
  const [isLoading, setIsLoading] = useState(false);
  const [progress, setProgress] = useState<SuggestProgress | null>(null);
  const sseRef = useRef<SSE | null>(null);

  useEffect(() => () => sseRef.current?.close(), []);

  const suggest = useCallback(
    (params: MCPViewsSuggestParams) => {
      sseRef.current?.close();
      const sse = new SSE(mcpViewsSuggest(), {
        payload: JSON.stringify(params),
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      });
      sseRef.current = sse;
      setIsLoading(true);
      setProgress(null);

      const finish = () => {
        sse.close();
        sseRef.current = null;
        setIsLoading(false);
        setProgress(null);
      };

      sse.addEventListener('message', (e: MessageEvent) => {
        const event = JSON.parse(e.data) as MCPViewsSuggestEvent;
        if (event.type === 'result') {
          finish();
          onResult(event.views, event.notes);
          return;
        }
        if (event.type === 'error') {
          finish();
          onError(event.error);
          return;
        }
        setProgress(event);
      });

      sse.addEventListener('error', () => {
        if (sseRef.current !== sse) {
          return;
        }
        finish();
        onError();
      });

      sse.stream();
    },
    [token, onResult, onError],
  );

  return { suggest, isLoading, progress };
}
