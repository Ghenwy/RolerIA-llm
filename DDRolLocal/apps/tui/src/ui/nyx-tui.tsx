import type { ApplicationCommandHandler } from '@nyx/application';
import type { DesignTurnEnvelope } from '@nyx/contracts';
import { Box, Text, useInput } from 'ink';
import { useState } from 'react';
import { randomUUID } from 'node:crypto';

export interface PlayerViewModel {
  campaignId: string;
  status: 'waiting' | 'thinking' | 'ready' | 'blocked';
  narration: string;
  statusMessage: string;
  draft: string;
}

export interface OperatorViewModel {
  runtime: 'saludable' | 'detenido' | 'no disponible';
  campaignId: string;
  stateVersion: number;
  queuedJobs: number;
  lastCheckpointId: string | null;
  failures: readonly {
    jobId: string;
    status: string;
    reasonCode: string;
  }[];
}

export type NyxTuiProps =
  | { readonly mode: 'player'; readonly player: PlayerViewModel }
  | { readonly mode: 'operator'; readonly operator: OperatorViewModel };

function PlayerView({ view }: { readonly view: PlayerViewModel }) {
  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1}>
      <Text bold color="cyan">Nyx RPG · Campaña {view.campaignId}</Text>
      <Text>{view.narration.length > 0 ? view.narration : 'La historia espera tu siguiente acción.'}</Text>
      <Text color={view.status === 'blocked' ? 'red' : 'yellow'}>{view.statusMessage}</Text>
      <Text>&gt; {view.draft}</Text>
    </Box>
  );
}

function OperatorView({ view }: { readonly view: OperatorViewModel }) {
  return (
    <Box flexDirection="column" borderStyle="single" paddingX={1}>
      <Text bold color="magenta">Nyx RPG · Operador</Text>
      <Text>Runtime: {view.runtime}</Text>
      <Text>Campaña: {view.campaignId}</Text>
      <Text>Versión de estado: {view.stateVersion}</Text>
      <Text>Trabajos en cola: {view.queuedJobs}</Text>
      <Text>Último checkpoint: {view.lastCheckpointId ?? 'ninguno'}</Text>
      {view.failures.map(failure => (
        <Text key={failure.jobId} color="red">
          {failure.jobId}: {failure.status} ({failure.reasonCode})
        </Text>
      ))}
    </Box>
  );
}

export function parseOperatorViewModel(value: unknown): OperatorViewModel | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (
    (record['runtime'] !== 'saludable' && record['runtime'] !== 'detenido' && record['runtime'] !== 'no disponible')
    || typeof record['campaignId'] !== 'string'
    || !Number.isSafeInteger(record['stateVersion'])
    || !Number.isSafeInteger(record['queuedJobs'])
    || (record['lastCheckpointId'] !== null && typeof record['lastCheckpointId'] !== 'string')
    || !Array.isArray(record['failures'])
  ) return undefined;
  const failures: Array<{ jobId: string; status: string; reasonCode: string }> = [];
  for (const failure of record['failures']) {
    if (typeof failure !== 'object' || failure === null || Array.isArray(failure)) return undefined;
    const candidate = failure as Record<string, unknown>;
    if (
      typeof candidate['jobId'] !== 'string'
      || typeof candidate['status'] !== 'string'
      || typeof candidate['reasonCode'] !== 'string'
    ) return undefined;
    failures.push({
      jobId: candidate['jobId'],
      status: candidate['status'],
      reasonCode: candidate['reasonCode']
    });
  }
  return {
    runtime: record['runtime'],
    campaignId: record['campaignId'],
    stateVersion: record['stateVersion'] as number,
    queuedJobs: record['queuedJobs'] as number,
    lastCheckpointId: record['lastCheckpointId'] as string | null,
    failures
  };
}

export function NyxTui(props: NyxTuiProps) {
  if (props.mode === 'operator') return <OperatorView view={props.operator} />;
  return <PlayerView view={props.player} />;
}

export interface InteractiveNyxTuiProps {
  application: ApplicationCommandHandler;
  campaignId: string;
  turnId: string;
  baseStateVersion: number;
  language: string;
  contextRefs?: readonly DesignTurnEnvelope.ContentRef[];
  onExit?: () => void;
}

export function nextTurnId(current: string): string {
  const match = /^(.*?)(\d+)$/.exec(current);
  if (!match) return `TURN-${randomUUID()}`;
  const prefix = match[1] ?? '';
  const digits = match[2] ?? '0';
  const next = Number(digits) + 1;
  return Number.isSafeInteger(next)
    ? `${prefix}${String(next).padStart(digits.length, '0')}`
    : `TURN-${randomUUID()}`;
}

function committedVersion(data: unknown, fallback: number): number {
  if (typeof data !== 'object' || data === null || !('committedStateVersion' in data)) return fallback;
  const version = data.committedStateVersion;
  return typeof version === 'number' && Number.isSafeInteger(version) && version >= fallback ? version : fallback;
}

export function InteractiveNyxTui(props: InteractiveNyxTuiProps) {
  const [draft, setDraft] = useState('');
  const [stateVersion, setStateVersion] = useState(props.baseStateVersion);
  const [turnId, setTurnId] = useState(props.turnId);
  const [status, setStatus] = useState<PlayerViewModel['status']>('waiting');
  const [narration, setNarration] = useState('');
  const [statusMessage, setStatusMessage] = useState('Escribe tu acción y pulsa Intro.');

  useInput((input, key) => {
    if (key.escape) {
      props.onExit?.();
      return;
    }
    if (status === 'thinking') return;
    if (key.backspace || key.delete) {
      setDraft(current => current.slice(0, -1));
      return;
    }
    if (key.return) {
      const playerInput = draft.trim();
      if (playerInput.length === 0) return;
      setStatus('thinking');
      setStatusMessage('Resolviendo el turno…');
      void props.application.execute({
        kind: 'play',
        input: {
          campaignId: props.campaignId,
          turnId,
          baseStateVersion: stateVersion,
          playerInput,
          contextRefs: [...(props.contextRefs ?? [])],
          language: props.language
        }
      }).then(response => {
        if (response.ok) {
          setNarration(response.message);
          setStateVersion(current => committedVersion(response.data, current));
          setTurnId(current => nextTurnId(current));
          setStatus('ready');
          setStatusMessage('Tu turno.');
          setDraft('');
        } else {
          setStatus('blocked');
          setStatusMessage(response.message);
          setTurnId(current => nextTurnId(current));
          setDraft('');
        }
      }).catch(() => {
        setStatus('blocked');
        setStatusMessage('El turno falló de forma segura; no se confirmó ningún cambio.');
        setTurnId(current => nextTurnId(current));
        setDraft('');
      });
      return;
    }
    if (input.length > 0 && !key.ctrl && !key.meta) setDraft(current => current + input);
  });

  return <NyxTui mode="player" player={{
    campaignId: props.campaignId,
    status,
    narration,
    statusMessage,
    draft
  }} />;
}
