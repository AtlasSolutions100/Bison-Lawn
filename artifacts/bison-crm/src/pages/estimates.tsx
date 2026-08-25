import { useEffect, useMemo, useRef, useState } from 'react';
import { 
  useListEstimates, useGetEstimate, useCreateEstimate, useUpdateEstimate, useDeleteEstimate, useSendEstimate,
  useReconcileEstimateDelivery,
  useListEstimateFields, useCreateEstimateField, useUpdateEstimateField, useDeleteEstimateField,
  useListChargePresets, useCreateChargePreset, useUpdateChargePreset, useDeleteChargePreset,
  useListClients, useListServices
} from '@workspace/api-client-react';
import type { ChargePreset, Estimate, EstimateField, EstimateFieldInput, EstimateLine, Service } from '@workspace/api-client-react';
import { useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter } from '@/components/ui/dialog';
import { Download, Send, Trash2, Plus, AlertCircle, Pencil, Bookmark } from 'lucide-react';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { useUnsavedChangesWarning } from '@/hooks/use-unsaved-changes-warning';
import { cn } from '@/lib/utils';
import { Download, Send, Trash2, Plus, AlertCircle, Pencil, RotateCcw } from 'lucide-react';
import {

const isEditableDraft = (estimate: Estimate) =>
  estimate.status === 'draft' &&
  estimate.deliveryState !== 'sending' &&
  estimate.deliveryState !== 'provider_accepted';

export default function Estimates() {
  const { data: estimates, isLoading } = useListEstimates();
  const [tab, setTab] = useState('list');
  const [editing, setEditing] = useState<Estimate | null>(null);
  // The builder stays mounted across tab switches, so unsaved work is only ever
  // discarded by an action that replaces it (switching edit target, cancelling)
  // or by leaving the page. Both of those confirm first.
  const [builderDirty, setBuilderDirty] = useState(false);
  // Local autosave of the in-progress builder, so a crash or a closed window is
  // recoverable. Scoped to the signed-in admin.
  const { data: currentUser } = useGetCurrentUser({ query: { queryKey: ['me'] } });
  const storageKey = currentUser ? estimateDraftStorageKey(currentUser.id) : null;
  // Whether the stored draft has been looked at yet this visit, and the draft
  // waiting for the admin to restore or discard it.
  const [draftChecked, setDraftChecked] = useState(false);
  const [pendingDraft, setPendingDraft] = useState<EstimateDraft | null>(null);
  // Draft handed to the builder on restore. The nonce remounts the builder so
  // it initialises straight from the draft instead of re-deriving its state.
  const [restoredDraft, setRestoredDraft] = useState<EstimateDraft | null>(null);
  const [restoreNonce, setRestoreNonce] = useState(0);
  const deleteEstimate = useDeleteEstimate();
  const sendEstimate = useSendEstimate();
  const reconcileDelivery = useReconcileEstimateDelivery();
  const { data: clients } = useListClients();
  const queryClient = useQueryClient();
  const [sendTarget, setSendTarget] = useState<{ id: number; email: string; clientName: string } | null>(null);
  const [sendEmail, setSendEmail] = useState('');
  const [sendMessage, setSendMessage] = useState('Thank you for the opportunity to care for your property. Please review the attached estimate.');
  const [sendError, setSendError] = useState('');

  const openSend = (estimate: NonNullable<typeof estimates>[number]) => {
    const email = clients?.find(c => c.id === estimate.clientId)?.email ?? '';
    setSendTarget({ id: estimate.id, email, clientName: estimate.clientName ?? 'Client' });
    setSendEmail(email);
    setSendError('');
  };

  const handleSend = () => {
    if (!sendTarget) return;
    setSendError('');
    sendEstimate.mutate({ id: sendTarget.id, data: { toEmail: sendEmail, message: sendMessage } }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: ['/api/estimates'] });
        setSendTarget(null);
      },
      onError: (error) => {
        setSendError(error instanceof Error ? error.message : 'Email delivery failed. Please retry.');
      },
    });
  };

  useUnsavedChangesWarning(
    builderDirty,
    'This estimate has unsaved changes. Leave the Estimates page and discard them?',
  );

  // Look for a recoverable draft once per visit, after the data needed to
  // validate it has loaded. A draft is only offered when what it refers to
  // still exists — a deleted (or no longer editable) estimate, or a deleted
  // client, drops it instead of resurrecting it somewhere it does not belong.
  useEffect(() => {
    if (draftChecked || !storageKey || isLoading || !clients) return;
    setDraftChecked(true);
    const stored = readEstimateDraft(storageKey);
    if (!stored) return;
    if (stored.estimateId != null) {
      const target = estimates?.find(e => e.id === stored.estimateId);
      if (!target || !isEditableDraft(target)) {
        clearEstimateDraft(storageKey);
        return;
      }
      if (String(target.clientId) !== stored.clientId) {
        // The stored values were typed for a different client — never graft them on.
        clearEstimateDraft(storageKey);
        return;
      }
    } else if (stored.clientId !== '' && !clients.some(c => String(c.id) === stored.clientId)) {
      clearEstimateDraft(storageKey);
      return;
    }
    setPendingDraft(stored);
  }, [draftChecked, storageKey, isLoading, estimates, clients]);

  const restorePendingDraft = () => {
    if (!pendingDraft) return;
    const target = pendingDraft.estimateId == null
      ? null
      : estimates?.find(e => e.id === pendingDraft.estimateId) ?? null;
    if (pendingDraft.estimateId != null && (!target || !isEditableDraft(target))) {
      // Deleted or sent while the prompt was on screen.
      if (storageKey) clearEstimateDraft(storageKey);
      setPendingDraft(null);
      alert('That estimate is no longer an editable draft, so the recovered work was discarded.');
      return;
    }
    setEditing(target);
    setRestoredDraft(pendingDraft);
    setRestoreNonce(n => n + 1);
    setPendingDraft(null);
    setTab('builder');
  };

  const discardPendingDraft = () => {
    if (storageKey) clearEstimateDraft(storageKey);
    setPendingDraft(null);
  };

  const pendingDraftClientName = pendingDraft
    ? clients?.find(c => String(c.id) === pendingDraft.clientId)?.name ?? null
    : null;

  const startEdit = (estimate: Estimate) => {
    if (editing?.id === estimate.id) {
      setTab('builder');
      return;
    }
    if (
      builderDirty &&
      !confirm(
        editing
          ? `Discard the unsaved changes to estimate #${editing.id} and edit #${estimate.id} instead?`
          : `Discard the unsaved new estimate in the builder and edit #${estimate.id} instead?`,
      )
    ) {
      return;
    }
    setBuilderDirty(false);
    setRestoredDraft(null);
    setEditing(estimate);
    setTab('builder');
  };

  const closeBuilder = () => {
    setBuilderDirty(false);
    setRestoredDraft(null);
    setEditing(null);
    setTab('list');
  };

  const cancelEdit = () => {
    if (builderDirty && !confirm('Discard the unsaved changes to this estimate?')) return;
    closeBuilder();
  };

  const handleDelete = (id: number) => {
    if(confirm('Delete estimate?')) {
      deleteEstimate.mutate({ id }, {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: ['/api/estimates'] });
          // A recovered draft must never bring a deleted estimate back.
          if (storageKey && readEstimateDraft(storageKey)?.estimateId === id) clearEstimateDraft(storageKey);
          if (pendingDraft?.estimateId === id) setPendingDraft(null);
          if (editing?.id === id) closeBuilder();
        },
      });
    }
  };

  return (
    <div className="p-8 max-w-7xl mx-auto space-y-6 flex flex-col h-[calc(100vh-2rem)]">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Estimates</h1>
        <p className="text-muted-foreground mt-1">Build and send estimates.</p>
      </div>

      {pendingDraft && (
        <div className="flex flex-wrap items-start gap-3 rounded-lg border border-amber-300 bg-amber-50 p-4">
          <RotateCcw className="w-5 h-5 shrink-0 mt-0.5 text-amber-700" />
          <div className="flex-1 min-w-64">
            <p className="text-sm font-semibold text-amber-900">
              Unfinished estimate recovered from this browser
            </p>
            <p className="text-sm text-amber-800 mt-0.5">
              {pendingDraft.estimateId != null
                ? `Unsaved changes to draft estimate #${pendingDraft.estimateId}`
                : 'A new estimate you were building'}
              {pendingDraftClientName ? ` for ${pendingDraftClientName}` : ''}, last edited {describeDraftAge(pendingDraft.savedAt)}.
            </p>
            <p className="text-xs text-amber-700 mt-1">
              Autosave is paused until you restore or discard this.
            </p>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" onClick={discardPendingDraft}>Discard</Button>
            <Button onClick={restorePendingDraft}>Restore</Button>
          </div>
        </div>
      )}

      <Tabs value={tab} onValueChange={setTab} className="flex-1 flex flex-col">
        <div className="flex justify-between items-center mb-4">
          <TabsList>
            <TabsTrigger value="list">All Estimates</TabsTrigger>
            <TabsTrigger value="builder">
              {editing ? `Editing #${editing.id}` : 'Builder'}
              {builderDirty && (
                <span className="ml-1.5 text-amber-600" title="Unsaved changes" aria-label="Unsaved changes">•</span>
              )}
            </TabsTrigger>
            <TabsTrigger value="fields">Custom Fields</TabsTrigger>
            <TabsTrigger value="presets">Charge Presets</TabsTrigger>
          </TabsList>
        </div>

        <TabsContent value="list" className="flex-1 m-0">
          <div className="bg-card border rounded-lg shadow-sm flex-1 overflow-auto h-full">
            <Table>
              <TableHeader className="bg-muted/50">
                <TableRow>
                  <TableHead>Client</TableHead>
                  <TableHead>Total</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="w-32"></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {isLoading ? (
                  <TableRow><TableCell colSpan={4} className="text-center py-4">Loading...</TableCell></TableRow>
                ) : !estimates?.length ? (
                  <TableRow><TableCell colSpan={4} className="text-center py-4">No estimates found.</TableCell></TableRow>
                ) : (
                  estimates.map(e => (
                    <TableRow key={e.id}>
                      <TableCell className="font-medium">{e.clientName}</TableCell>
                      <TableCell className="font-semibold">${e.total.toLocaleString(undefined, {minimumFractionDigits:2})}</TableCell>
                      <TableCell>
                        <span className={`px-2 py-1 rounded text-xs font-bold ${
                          e.status === 'accepted' ? 'bg-green-100 text-green-800' :
                          e.status === 'declined' ? 'bg-red-100 text-red-800' :
                          e.status === 'sent' ? 'bg-primary/20 text-primary' : 'bg-muted text-muted-foreground'
                        }`}>
                          {e.status.toUpperCase()}
                        </span>
                        {e.lastDeliveryError && <div className="text-xs text-destructive mt-1">Delivery failed — retry available</div>}
                        {e.deliveryState === 'provider_accepted' && (
                          <div className="text-xs text-amber-700 mt-1">Gmail accepted — confirmation needs finishing</div>
                        )}
                      </TableCell>
                      <TableCell className="text-right space-x-1 whitespace-nowrap">
                        {isEditableDraft(e) && (
                          <Button
                            size="icon"
                            variant="ghost"
                            title="Edit this draft"
                            onClick={() => startEdit(e)}
                          >
                            <Pencil className="w-4 h-4" />
                          </Button>
                        )}
                        <Button
                          size="icon"
                          variant="ghost"
                          title="Preview or download PDF"
                          onClick={() => window.open(`/api/estimates/${e.id}/pdf`, '_blank', 'noopener,noreferrer')}
                        >
                          <Download className="w-4 h-4" />
                        </Button>
                        <Button
                          size="icon"
                          variant="ghost"
                          title={
                            e.status === 'accepted' || e.status === 'declined'
                              ? 'Final customer response recorded'
                              : e.deliveryState === 'sending' || e.deliveryState === 'provider_accepted'
                                ? 'Finish the existing delivery before sending again'
                                : e.sentAt ? 'Send again' : 'Email estimate'
                          }
                          disabled={
                            e.status === 'accepted' ||
                            e.status === 'declined' ||
                            e.deliveryState === 'sending' ||
                            e.deliveryState === 'provider_accepted'
                          }
                          className="text-primary hover:text-primary hover:bg-primary/10"
                          onClick={() => openSend(e)}
                        >
                          <Send className="w-4 h-4" />
                        </Button>
                        {(e.deliveryState === 'provider_accepted' || e.deliveryState === 'sending') && (
                          <Button
                            size="icon"
                            variant="ghost"
                            title="Confirm this email was sent without sending another copy"
                            onClick={() => {
                              if (!confirm('Only continue if Gmail shows this estimate was sent. This finishes the delivery record without sending another email.')) return;
                              reconcileDelivery.mutate(
                                { id: e.id },
                                { onSuccess: () => queryClient.invalidateQueries({ queryKey: ['/api/estimates'] }) },
                              );
                            }}
                          >
                            <AlertCircle className="w-4 h-4 text-amber-600" />
                          </Button>
                        )}
                        <Button size="icon" variant="ghost" className="text-muted-foreground hover:text-destructive" onClick={() => handleDelete(e.id)}>
                          <Trash2 className="w-4 h-4" />
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
        </TabsContent>

        {/* forceMount keeps the builder mounted while another tab is showing, so
            switching to "All Estimates" mid-build no longer destroys its state.
            Radix leaves force-mounted content visible, so hide it ourselves. */}
        <TabsContent
          value="builder"
          forceMount
          className={cn('flex-1 m-0', tab !== 'builder' && 'hidden')}
        >
          <EstimateBuilder
            key={`${editing ? `edit-${editing.id}` : 'new'}:${restoreNonce}`}
            editEstimate={editing}
            initialDraft={restoredDraft}
            storageKey={storageKey}
            // Never touch the stored draft before the admin has answered the
            // restore prompt, or a fresh builder would wipe the recovered work.
            persistDraft={draftChecked && !pendingDraft}
            onDirtyChange={setBuilderDirty}
            onFinished={closeBuilder}
            onCancelEdit={cancelEdit}
            onReloadEdit={(fresh) => setEditing(fresh)}
          />
        </TabsContent>

        <TabsContent value="fields" className="flex-1 m-0">
          <EstimateFields />
        </TabsContent>

        <TabsContent value="presets" className="flex-1 m-0">
          <ChargePresets />
        </TabsContent>
      </Tabs>

      <Dialog open={!!sendTarget} onOpenChange={open => !open && setSendTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Email estimate to {sendTarget?.clientName}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <label className="text-sm font-medium mb-1 block">Customer email</label>
              <Input
                type="email"
                value={sendEmail}
                onChange={e => setSendEmail(e.target.value)}
                placeholder="customer@example.com"
              />
            </div>
            <div>
              <label className="text-sm font-medium mb-1 block">Message</label>
              <textarea
                className="flex min-h-28 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                value={sendMessage}
                onChange={e => setSendMessage(e.target.value)}
              />
            </div>
            <p className="text-xs text-muted-foreground">
              The email includes a polished PDF plus secure Accept and Decline buttons.
            </p>
            {sendError && (
              <div className="flex gap-2 rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
                <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                <span>{sendError}</span>
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setSendTarget(null)}>Cancel</Button>
            <Button disabled={!sendEmail || sendEstimate.isPending} onClick={handleSend}>
              <Send className="w-4 h-4 mr-2" />
              {sendEstimate.isPending ? 'Sending…' : 'Send Estimate'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

const money = (n: number) => `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function fieldLinePrice(field: EstimateField, value: string): number | null {
  if (field.fieldType !== 'calculable') return null;
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || value.trim() === '') return null;
  const unitSize = field.unitSize && field.unitSize > 0 ? field.unitSize : 1;
  return Math.round((numeric / unitSize) * (field.pricePerUnit ?? 0) * 100) / 100;
}

function serviceLinePrice(service: Service, value: string): number {
  const numeric = Number(value);
  const eqs = service.pricingEquations ?? [];
  if (eqs.length > 0 && Number.isFinite(numeric) && value.trim() !== '') {
    let idx = eqs.findIndex(e => e.upToSqft != null && numeric <= e.upToSqft);
    if (idx === -1) {
      idx = eqs.findIndex(e => e.upToSqft == null);
      if (idx === -1) idx = eqs.length - 1;
    }
    const eq = eqs[idx];
    let price = eq.basePrice;
    if (numeric > eq.baseSqft && eq.incrementSqft > 0) {
      price += Math.ceil((numeric - eq.baseSqft) / eq.incrementSqft) * eq.incrementPrice;
    }
    return Math.round(price * 100) / 100;
  }
  return Math.round(service.rate * service.quantity * 100) / 100;
}

type SelectionState = Record<number, { selected: boolean; value: string }>;
type CustomLineDraft = { key: number; label: string; value: string; price: string };

let customLineKeySeq = 0;
const nextCustomLineKey = () => ++customLineKeySeq;

/** Blank means "not entered yet"; anything non-numeric is rejected the same way. */
function customLinePrice(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  const numeric = Number(trimmed);
  return Number.isFinite(numeric) ? Math.round(numeric * 100) / 100 : null;
}

function builderSnapshot(
  clientId: string,
  notes: string,
  fields: SelectionState,
  services: SelectionState,
  customLines: CustomLineDraft[],
) {
  const normalize = (state: SelectionState) =>
    Object.entries(state)
      .filter(([, v]) => v.selected || v.value !== '')
      .map(([id, v]) => [Number(id), v.selected, v.value] as const)
      .sort((a, b) => a[0] - b[0]);
  return JSON.stringify({
    clientId,
    notes,
    fields: normalize(fields),
    services: normalize(services),
    custom: customLines.map(c => [c.label, c.value, c.price]),
  });
}

/** Selection maps travel to localStorage as arrays so their key order cannot drift. */
function selectionToStored(state: SelectionState): StoredSelection[] {
  return Object.entries(state)
    .filter(([, v]) => v.selected || v.value !== '')
    .map(([id, v]) => ({ id: Number(id), selected: v.selected, value: v.value }))
    .sort((a, b) => a.id - b.id);
}
type VersionConflict = { message: string; current: Estimate | null };
function EstimateBuilder({
  editEstimate, initialDraft, storageKey, persistDraft,
  onDirtyChange, onFinished, onCancelEdit, onReloadEdit,
}: {
  editEstimate: Estimate | null;
  /** Recovered local draft this builder was mounted to restore, if any. */
  initialDraft: EstimateDraft | null;
  storageKey: string | null;
  persistDraft: boolean;
  onDirtyChange: (dirty: boolean) => void;
  onFinished: () => void;
  onCancelEdit: () => void;
  onReloadEdit: (estimate: Estimate) => void;
}) {
  // On an edit the client always comes from the saved estimate (it cannot be
  // changed), so a restore can never attach one client's values to another's.
  const [clientId, setClientId] = useState(
    editEstimate ? String(editEstimate.clientId) : initialDraft?.clientId ?? '',
  );
  const [notes, setNotes] = useState(initialDraft ? initialDraft.notes : editEstimate?.notes ?? '');
  const [savePropertyData, setSavePropertyData] = useState(initialDraft ? initialDraft.savePropertyData : true);
  const [fieldValues, setFieldValues] = useState<SelectionState>(() => selectionFromStored(initialDraft?.fields));
  const [serviceValues, setServiceValues] = useState<SelectionState>(() => selectionFromStored(initialDraft?.services));
  // Saved lines whose field/service no longer exists. They are carried through
  // an edit untouched so an edit never silently drops part of the estimate.
  const [carriedLines, setCarriedLines] = useState<EstimateLine[]>([]);
  // One-off charges (haul-away, dump fee, discount) entered by hand.
  const [customLines, setCustomLines] = useState<CustomLineDraft[]>(
    () => (initialDraft?.customLines ?? []).map(c => ({ key: nextCustomLineKey(), ...c })),
  );
  const [conflict, setConflict] = useState<VersionConflict | null>(null);
  // Snapshot of the last saved state. For a draft edit that is the hydrated
  // draft; for a new estimate it stays empty, so picking a client already
  // counts as unsaved work worth warning about before leaving the page.
  const baselineRef = useRef(
    builderSnapshot(editEstimate ? String(editEstimate.clientId) : '', editEstimate?.notes ?? '', {}, {}, []),
  );
  // Snapshot taken right after a client's saved property values are prefilled.
  // Used only to decide whether switching clients would throw away typing —
  // an untouched prefill can be replaced without nagging the admin.
  const prefillRef = useRef(baselineRef.current);
  const { data: clients } = useListClients();
  const { data: fields } = useListEstimateFields();
  const { data: services } = useListServices();
  const { data: chargePresets } = useListChargePresets();
  const createPreset = useCreateChargePreset();
  const createEstimate = useCreateEstimate();
  const updateEstimate = useUpdateEstimate();
  const queryClient = useQueryClient();

  // Fetched on demand only, to pull the newest saved copy after a conflict.
  const savedEstimate = useGetEstimate(editEstimate?.id ?? 1, {
    query: { enabled: false, queryKey: ['/api/estimates', editEstimate?.id ?? 1] },
  });

  const client = clients?.find(c => String(c.id) === clientId);

  // Rebuild the builder state from scratch whenever the selected client changes,
  // so one customer's property values can never leak into another customer's
  // estimate. Runs as an effect keyed on data-loaded flags (not array identity)
  // so late-arriving query results still trigger the prefill without background
  // refetches wiping in-progress edits.
  const clientsLoaded = clients != null;
  const fieldsLoaded = fields != null;
  const servicesLoaded = services != null;

  // A restored draft supplies the values itself, so the effects below must not
  // overwrite them the first time they run. Both guards are one-shot: any later
  // hydrate (a reload after a version conflict) or client change behaves normally.
  const pendingRestoredEditRef = useRef(initialDraft != null && editEstimate != null);
  const pendingRestoredClientRef = useRef<string | null>(
    initialDraft != null && editEstimate == null ? initialDraft.clientId : null,
  );

  // Editing: hydrate the selectors from the saved draft's lines once the field
  // and service catalogs are available.
  useEffect(() => {
    if (!editEstimate || !fieldsLoaded || !servicesLoaded) return;
    const nextFields: SelectionState = {};
    const nextServices: SelectionState = {};
    const carried: EstimateLine[] = [];
    const custom: CustomLineDraft[] = [];
    for (const line of editEstimate.lines) {
      if (line.fieldId != null && fields.some(f => f.id === line.fieldId)) {
        nextFields[line.fieldId] = { selected: true, value: line.value };
      } else if (line.serviceId != null && services.some(s => s.id === line.serviceId)) {
        nextServices[line.serviceId] = { selected: true, value: line.value };
      } else if (line.fieldId == null && line.serviceId == null) {
        // A custom one-off charge — editable, unlike a line whose definition is gone.
        custom.push({
          key: nextCustomLineKey(),
          label: line.label,
          value: line.value,
          price: line.calculatedPrice == null ? '' : String(line.calculatedPrice),
        });
      } else {
        carried.push(line);
      }
    }
    // Lines whose field/service is gone are not editable, so they always come
    // from the saved estimate rather than from a recovered draft.
    setCarriedLines(carried);
    // The baseline is the *saved* estimate either way, so restored edits still
    // read as unsaved changes.
    baselineRef.current = builderSnapshot(
      String(editEstimate.clientId), editEstimate.notes ?? '', nextFields, nextServices, custom,
    );
    prefillRef.current = baselineRef.current;
    if (pendingRestoredEditRef.current) {
      pendingRestoredEditRef.current = false;
      return;
    }
    setFieldValues(nextFields);
    setServiceValues(nextServices);
    setCustomLines(custom);
  }, [editEstimate, fieldsLoaded, servicesLoaded]);

  useEffect(() => {
    if (editEstimate) return; // edit mode hydrates from the saved estimate instead
    if (pendingRestoredClientRef.current === clientId) {
      // Keep the recovered values for this client instead of re-prefilling over
      // them. Consumed only once the data that would clobber them has loaded.
      if (clientsLoaded && fieldsLoaded) pendingRestoredClientRef.current = null;
      return;
    }
    pendingRestoredClientRef.current = null;
    if (!clientId) {
      setFieldValues({});
      setServiceValues({});
      prefillRef.current = builderSnapshot('', '', {}, {}, []);
      return;
    }
    if (!clientsLoaded || !fieldsLoaded) return;
    const property = (clients.find(c => String(c.id) === clientId)?.propertyData ?? {}) as Record<string, string>;
    const next: SelectionState = {};
    for (const f of fields) {
      const saved = property[f.label];
      next[f.id] = { selected: saved != null, value: saved ?? '' };
    }
    setFieldValues(next);
    setServiceValues({});
    // A brand new estimate is never "saved", so the baseline stays empty and the
    // chosen client counts as unsaved work. The prefill snapshot is separate:
    // replacing an untouched prefill costs the admin nothing.
    prefillRef.current = builderSnapshot(clientId, notes, next, {}, customLines);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clientId, clientsLoaded, fieldsLoaded]);

  const current = builderSnapshot(clientId, notes, fieldValues, serviceValues, customLines);
  const dirty = current !== baselineRef.current;
  // Values the admin typed on top of the current client's prefill.
  const hasTypedValues = current !== prefillRef.current;
  useEffect(() => {
    onDirtyChange(dirty);
  }, [dirty, onDirtyChange]);

  // Mirror unsaved work into local storage as it changes so a crash, a closed
  // window or a sleeping laptop stays recoverable. Once the builder matches
  // what is saved there is nothing worth recovering, so the copy is removed.
  useEffect(() => {
    if (!persistDraft || !storageKey) return;
    if (!dirty) {
      clearEstimateDraft(storageKey);
      return;
    }
    writeEstimateDraft(storageKey, {
      estimateId: editEstimate?.id ?? null,
      clientId,
      notes,
      savePropertyData,
      fields: selectionToStored(fieldValues),
      services: selectionToStored(serviceValues),
      customLines: customLines.map(({ label, value, price }) => ({ label, value, price })),
      savedAt: new Date().toISOString(),
    });
    // `current` is the snapshot of everything above, so it changes on every edit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [persistDraft, storageKey, dirty, current, savePropertyData, editEstimate?.id]);

  // Changing the client rebuilds the whole form from the new client's saved
  // property values, so confirm first if that would throw away typing.
  const handleClientChange = (event: React.ChangeEvent<HTMLSelectElement>) => {
    const nextClientId = event.target.value;
    if (nextClientId === clientId) return;
    // Picking the first client discards nothing, so it never prompts.
    const replacingAClient = clientId !== '';
    if (
      replacingAClient &&
      hasTypedValues &&
      !confirm('Switching clients clears the values, custom lines, and notes entered for the current client. Discard them?')
    ) {
      event.target.value = clientId; // keep the select in sync with the unchanged state
      return;
    }
    if (replacingAClient) {
      setNotes('');
      setCustomLines([]);
    }
    setClientId(nextClientId);
  };

  const lines = useMemo(() => {
    const result: { fieldId?: number | null; serviceId?: number | null; label: string; value: string; calculatedPrice: number | null }[] = [];
    for (const carried of carriedLines) {
      result.push({ ...carried, calculatedPrice: carried.calculatedPrice ?? null });
    }
    for (const f of fields ?? []) {
      const state = fieldValues[f.id];
      if (!state?.selected) continue;
      result.push({ fieldId: f.id, label: f.label, value: state.value, calculatedPrice: fieldLinePrice(f, state.value) });
    }
    for (const s of services ?? []) {
      const state = serviceValues[s.id];
      if (!state?.selected) continue;
      result.push({ serviceId: s.id, label: s.name, value: state.value, calculatedPrice: serviceLinePrice(s, state.value) });
    }
    for (const c of customLines) {
      result.push({
        fieldId: null,
        serviceId: null,
        label: c.label.trim(),
        value: c.value.trim(),
        calculatedPrice: customLinePrice(c.price),
      });
    }
    return result;
  }, [fields, services, fieldValues, serviceValues, carriedLines, customLines]);

  const total = lines.reduce((sum, l) => sum + (l.calculatedPrice ?? 0), 0);
  const invalidCalculable = (fields ?? []).some(f => {
    const state = fieldValues[f.id];
    return state?.selected && f.fieldType === 'calculable' && (state.value.trim() === '' || !Number.isFinite(Number(state.value)));
  });
  const invalidCustom = customLines.some(c => c.label.trim() === '' || customLinePrice(c.price) == null);
  // A discount larger than the rest of the estimate would owe the customer
  // money; the server rejects it, so flag it here before the save round-trip.
  const negativeTotal = lines.length > 0 && !invalidCustom && !invalidCalculable && Math.round(total * 100) / 100 < 0;

  const saving = createEstimate.isPending || updateEstimate.isPending;

  // Pull the newest saved copy of this draft into the builder, discarding the
  // rejected edit so the admin reapplies their changes on top of the current one.
  const handleReloadCurrent = async () => {
    if (!editEstimate) return;
    const refetched = await savedEstimate.refetch();
    const fresh = refetched.data ?? conflict?.current;
    if (!fresh) return;
    queryClient.invalidateQueries({ queryKey: ['/api/estimates'] });
    setNotes(fresh.notes ?? '');
    setConflict(null);
    onReloadEdit(fresh);
  };

  const handleSave = () => {
    const payload = lines.map(({ calculatedPrice, ...line }) => ({ ...line, calculatedPrice }));
    const onError = (error: unknown) =>
      alert(error instanceof Error ? error.message : 'Could not save estimate');

    if (editEstimate) {
      setConflict(null);
      updateEstimate.mutate({
        id: editEstimate.id,
        data: { version: editEstimate.version, notes: notes.trim() || null, lines: payload },
      }, {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: ['/api/estimates'] });
          if (storageKey) clearEstimateDraft(storageKey);
          onFinished();
        },
        onError: (error) => {
          const versionConflict = readVersionConflict(error);
          if (versionConflict) {
            setConflict(versionConflict);
            return;
          }
          onError(error);
        },
      });
      return;
    }

    const savedClientId = parseInt(clientId);
    createEstimate.mutate({
      data: {
        clientId: savedClientId,
        notes: notes.trim() || undefined,
        savePropertyData,
        lines: payload,
      }
    }, {
      onSuccess: (estimate) => {
        queryClient.invalidateQueries({ queryKey: ['/api/estimates'] });
        if (storageKey) clearEstimateDraft(storageKey);
        // The server reports exactly which property details it wrote, so the
        // confirmation never claims an update that did not happen.
        const updated = estimate.propertyDataUpdated ?? [];
        if (updated.length) {
          queryClient.invalidateQueries({ queryKey: ['/api/clients'] });
          queryClient.invalidateQueries({ queryKey: [`/api/clients/${savedClientId}`] });
          queryClient.invalidateQueries({ queryKey: [`/api/clients/${savedClientId}/audit`] });
        }
        setClientId('');
        setNotes('');
        setFieldValues({});
        setServiceValues({});
        setCustomLines([]);
        alert(updated.length
          ? `Estimate created — property details updated: ${updated.join(', ')}`
          : 'Estimate created');
      },
      onError,
    });
  };

  const fieldInput = (f: EstimateField) => {
    const state = fieldValues[f.id] ?? { selected: false, value: '' };
    const set = (patch: Partial<typeof state>) => setFieldValues(prev => ({ ...prev, [f.id]: { ...state, ...patch } }));
    return (
      <div key={f.id} className={`flex items-center gap-3 p-3 rounded-md border ${state.selected ? 'bg-background' : 'bg-muted/40'}`}>
        <input type="checkbox" className="w-4 h-4" checked={state.selected} onChange={e => set({ selected: e.target.checked })} />
        <div className="w-56">
          <div className="text-sm font-medium">{f.label}</div>
          {f.fieldType === 'calculable' && (
            <div className="text-xs text-muted-foreground">${f.pricePerUnit ?? 0} per {f.unitSize ?? 1} units</div>
          )}
        </div>
        {f.fieldType === 'boolean' ? (
          <select
            className="h-9 rounded-md border border-input bg-background px-2 text-sm"
            disabled={!state.selected}
            value={state.value}
            onChange={e => set({ value: e.target.value })}
          >
            <option value="">—</option>
            <option value="Yes">Yes</option>
            <option value="No">No</option>
          </select>
        ) : (
          <Input
            type={f.fieldType === 'text' ? 'text' : 'number'}
            className="w-40"
            disabled={!state.selected}
            value={state.value}
            onChange={e => set({ value: e.target.value })}
            placeholder={f.fieldType === 'text' ? 'Detail' : 'Value'}
          />
        )}
        <span className="ml-auto text-sm font-semibold tabular-nums">
          {state.selected && f.fieldType === 'calculable'
            ? (fieldLinePrice(f, state.value) == null ? 'Enter a number' : money(fieldLinePrice(f, state.value)!))
            : state.selected ? '—' : ''}
        </span>
      </div>
    );
  };

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_320px] items-start">
      <div className="bg-card p-6 border rounded-lg shadow-sm space-y-5">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-xl font-bold">{editEstimate ? `Edit Draft Estimate #${editEstimate.id}` : 'New Estimate'}</h2>
            {editEstimate && (
              <p className="text-sm text-muted-foreground mt-1">
                Only drafts can be edited. Lines are repriced from the current field and service settings when you save.
              </p>
            )}
          </div>
          {editEstimate && <Button variant="outline" onClick={onCancelEdit}>Cancel edit</Button>}
        </div>
        <div>
          <label className="text-sm font-medium mb-1 block">Client</label>
          <select
            className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm disabled:opacity-70"
            value={clientId}
            disabled={!!editEstimate}
            onChange={handleClientChange}
          >
            <option value="">Select client...</option>
            {clients?.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          {editEstimate ? (
            <p className="text-xs text-muted-foreground mt-1">The client cannot be changed on an existing estimate.</p>
          ) : client && Object.keys(client.propertyData ?? {}).length > 0 ? (
            <p className="text-xs text-muted-foreground mt-1">Values prefilled from {client.name}'s saved property details.</p>
          ) : null}
        </div>

        <div>
          <h3 className="text-sm font-semibold mb-2">Property Fields</h3>
          {!fields?.length ? (
            <p className="text-sm text-muted-foreground">No reusable fields yet — add them in the Custom Fields tab.</p>
          ) : (
            <div className="space-y-2">{fields.map(fieldInput)}</div>
          )}
        </div>

        <div>
          <h3 className="text-sm font-semibold mb-2">Services</h3>
          {!services?.length ? (
            <p className="text-sm text-muted-foreground">No services configured.</p>
          ) : (
            <div className="space-y-2">
              {services.map(s => {
                const state = serviceValues[s.id] ?? { selected: false, value: '' };
                const set = (patch: Partial<typeof state>) => setServiceValues(prev => ({ ...prev, [s.id]: { ...state, ...patch } }));
                const hasEquations = (s.pricingEquations ?? []).length > 0;
                return (
                  <div key={s.id} className={`flex items-center gap-3 p-3 rounded-md border ${state.selected ? 'bg-background' : 'bg-muted/40'}`}>
                    <input type="checkbox" className="w-4 h-4" checked={state.selected} onChange={e => set({ selected: e.target.checked })} />
                    <div className="w-56">
                      <div className="text-sm font-medium">{s.name}</div>
                      <div className="text-xs text-muted-foreground">
                        {hasEquations ? 'Priced from sqft equations' : `Flat ${money(s.rate * s.quantity)}`}
                      </div>
                    </div>
                    {hasEquations && (
                      <Input
                        type="number"
                        className="w-40"
                        disabled={!state.selected}
                        value={state.value}
                        onChange={e => set({ value: e.target.value })}
                        placeholder="Sqft"
                      />
                    )}
                    <span className="ml-auto text-sm font-semibold tabular-nums">
                      {state.selected ? money(serviceLinePrice(s, state.value)) : ''}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div>
          <div className="flex items-center justify-between mb-2">
            <div>
              <h3 className="text-sm font-semibold">Custom Lines</h3>
              <p className="text-xs text-muted-foreground">One-off charges like a haul-away, dump fee, or a discount (use a negative price).</p>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setCustomLines(prev => [...prev, { key: nextCustomLineKey(), label: '', value: '', price: '' }])}
            >
              <Plus className="w-4 h-4 mr-2" /> Add custom line
            </Button>
          </div>
          {/* Presets are templates: inserting one copies its label and price onto
              this estimate, and both stay editable here without touching the preset. */}
          {chargePresets?.length ? (
            <div className="flex flex-wrap items-center gap-2 mb-3 rounded-md border bg-muted/40 p-3">
              <span className="text-xs font-medium text-muted-foreground mr-1">Insert a saved charge:</span>
              {chargePresets.map(p => (
                <Button
                  key={p.id}
                  variant="outline"
                  size="sm"
                  className="h-7"
                  title={`Add "${p.label}" at ${money(p.defaultPrice)} — the price stays editable on this estimate`}
                  onClick={() => setCustomLines(prev => [
                    ...prev,
                    { key: nextCustomLineKey(), label: p.label, value: '', price: String(p.defaultPrice) },
                  ])}
                >
                  <Plus className="w-3 h-3 mr-1" />
                  {p.label} <span className="ml-1 tabular-nums text-muted-foreground">{money(p.defaultPrice)}</span>
                </Button>
              ))}
            </div>
          ) : null}
          {!customLines.length ? (
            <p className="text-sm text-muted-foreground">No custom lines.</p>
          ) : (
            <div className="space-y-2">
              {customLines.map(c => {
                const set = (patch: Partial<CustomLineDraft>) =>
                  setCustomLines(prev => prev.map(line => (line.key === c.key ? { ...line, ...patch } : line)));
                const priceInvalid = customLinePrice(c.price) == null;
                return (
                  <div key={c.key} className="flex items-center gap-3 p-3 rounded-md border bg-background">
                    <Input
                      className="w-56"
                      value={c.label}
                      onChange={e => set({ label: e.target.value })}
                      placeholder="Label (e.g. Haul-away)"
                    />
                    <Input
                      className="flex-1"
                      value={c.value}
                      onChange={e => set({ value: e.target.value })}
                      placeholder="Description (optional)"
                    />
                    <Input
                      type="number"
                      step="0.01"
                      className={`w-32 ${priceInvalid ? 'border-destructive' : ''}`}
                      value={c.price}
                      onChange={e => set({ price: e.target.value })}
                      placeholder="Price"
                    />
                    <Button
                      size="icon"
                      variant="ghost"
                      title={
                        c.label.trim() === '' || priceInvalid
                          ? 'Give this line a label and a numeric price to save it as a preset'
                          : `Save "${c.label.trim()}" as a reusable charge preset`
                      }
                      className="text-muted-foreground hover:text-primary"
                      disabled={c.label.trim() === '' || priceInvalid || createPreset.isPending}
                      onClick={() => createPreset.mutate(
                        { data: { label: c.label.trim(), defaultPrice: customLinePrice(c.price)! } },
                        {
                          onSuccess: () => queryClient.invalidateQueries({ queryKey: ['/api/charge-presets'] }),
                          onError: (error) =>
                            alert(error instanceof Error ? error.message : 'Could not save this preset'),
                        },
                      )}
                    >
                      <Bookmark className="w-4 h-4" />
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      title="Remove this custom line"
                      className="text-muted-foreground hover:text-destructive"
                      onClick={() => setCustomLines(prev => prev.filter(line => line.key !== c.key))}
                    >
                      <Trash2 className="w-4 h-4" />
                    </Button>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div>
          <label className="text-sm font-medium mb-1 block">Notes</label>
          <textarea
            className="flex min-h-20 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            value={notes}
            onChange={e => setNotes(e.target.value)}
            placeholder="Optional notes shown on the estimate"
          />
        </div>

        {!editEstimate && (
          <label className="flex items-start gap-3 rounded-md border bg-muted/40 p-3 cursor-pointer">
            <input
              type="checkbox"
              className="w-4 h-4 mt-0.5"
              checked={savePropertyData}
              onChange={e => setSavePropertyData(e.target.checked)}
            />
            <span className="text-sm">
              <span className="font-medium">Save these field values to the client's property details</span>
              <span className="block text-xs text-muted-foreground mt-0.5">
                Selected fields with a value{client ? ` update ${client.name}'s` : ' update the client\'s'} saved property details, so the next estimate starts from the corrected numbers. Blank values and unselected fields leave existing details untouched.
              </span>
            </span>
          </label>
        )}
      </div>

      <div className="bg-card p-6 border rounded-lg shadow-sm space-y-3 sticky top-4">
        <h3 className="text-sm font-semibold">Summary</h3>
        {!lines.length ? (
          <p className="text-sm text-muted-foreground">Select fields or services to build the estimate.</p>
        ) : (
          <div className="space-y-1">
            {lines.map((l, i) => (
              <div key={i} className="flex justify-between text-sm gap-2">
                <span className="truncate">{l.label}{l.value ? ` — ${l.value}` : ''}</span>
                <span className="tabular-nums shrink-0">{l.calculatedPrice == null ? '—' : money(l.calculatedPrice)}</span>
              </div>
            ))}
          </div>
        )}
        {carriedLines.length > 0 && (
          <p className="text-xs text-muted-foreground">
            {carriedLines.length} saved line{carriedLines.length === 1 ? '' : 's'} came from a field or service that no longer exists. They are kept as-is.
          </p>
        )}
        <div className={`flex justify-between border-t pt-2 font-bold ${negativeTotal ? 'text-destructive' : ''}`}>
          <span>Total</span>
          <span className="tabular-nums">{money(total)}</span>
        </div>
        {conflict && (
          <div className="space-y-2 rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
            <div className="flex gap-2">
              <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
              <span>
                {conflict.message}
                {conflict.current && ` Their version totals ${money(conflict.current.total)}.`}
              </span>
            </div>
            <Button
              size="sm"
              variant="outline"
              className="w-full"
              disabled={savedEstimate.isFetching}
              onClick={handleReloadCurrent}
            >
              {savedEstimate.isFetching ? 'Reloading…' : 'Reload current version'}
            </Button>
          </div>
        )}
        {invalidCalculable && <p className="text-xs text-destructive">Enter numeric values for all selected calculable fields.</p>}
        {invalidCustom && <p className="text-xs text-destructive">Give every custom line a label and a numeric price.</p>}
        {negativeTotal && (
          <p className="text-xs text-destructive">
            This total would owe the customer money. Check the discount amount — the total must be zero or more.
          </p>
        )}
        <Button className="w-full" disabled={!clientId || !lines.length || invalidCalculable || invalidCustom || negativeTotal || saving} onClick={handleSave}>
          {saving ? 'Saving…' : editEstimate ? 'Save Changes' : 'Save Estimate'}
        </Button>
        {editEstimate && (
          <Button variant="outline" className="w-full" disabled={saving} onClick={onCancelEdit}>Cancel</Button>
        )}
      </div>
    </div>
  );
}

const EMPTY_FIELD_FORM: EstimateFieldInput = { label: '', fieldType: 'calculable', pricePerUnit: null, unitSize: null, sortOrder: null };

function EstimateFields() {
  const { data: fields, isLoading } = useListEstimateFields();
  const createField = useCreateEstimateField();
  const updateField = useUpdateEstimateField();
  const deleteField = useDeleteEstimateField();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<{ id: number | null; form: EstimateFieldInput } | null>(null);
  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['/api/estimate-fields'] });

  const saveForm = () => {
    if (!editing || !editing.form.label.trim()) return;
    const data: EstimateFieldInput = {
      ...editing.form,
      label: editing.form.label.trim(),
      pricePerUnit: editing.form.fieldType === 'calculable' ? editing.form.pricePerUnit : null,
      unitSize: editing.form.fieldType === 'calculable' ? editing.form.unitSize : null,
    };
    const done = { onSuccess: () => { invalidate(); setEditing(null); } };
    if (editing.id == null) createField.mutate({ data }, done);
    else updateField.mutate({ id: editing.id, data }, done);
  };

  const formNumber = (key: 'pricePerUnit' | 'unitSize' | 'sortOrder') => ({
    value: editing?.form[key] ?? '',
    onChange: (e: React.ChangeEvent<HTMLInputElement>) =>
      setEditing(prev => prev && ({ ...prev, form: { ...prev.form, [key]: e.target.value === '' ? null : Number(e.target.value) } })),
  });

  return (
    <div className="bg-card border rounded-lg shadow-sm flex-1 overflow-auto h-full p-6 space-y-4">
      <div className="flex justify-between items-center">
        <div>
          <h2 className="text-xl font-bold">Reusable Fields</h2>
          <p className="text-sm text-muted-foreground">Property details like Turf Sqft, Gate Code, or Sprinkler Zones. Calculable fields price line items automatically.</p>
        </div>
        <Button onClick={() => setEditing({ id: null, form: { ...EMPTY_FIELD_FORM } })}>
          <Plus className="w-4 h-4 mr-2" /> Add Field
        </Button>
      </div>

      {isLoading ? <div>Loading...</div> :
       !fields?.length ? <div className="text-sm text-muted-foreground">No fields configured.</div> :
       <Table>
         <TableHeader>
           <TableRow>
             <TableHead>Label</TableHead>
             <TableHead>Type</TableHead>
             <TableHead>Pricing</TableHead>
             <TableHead>Sort</TableHead>
             <TableHead className="w-24"></TableHead>
           </TableRow>
         </TableHeader>
         <TableBody>
           {fields.map(f => (
             <TableRow key={f.id}>
               <TableCell className="font-medium">{f.label}</TableCell>
               <TableCell className="capitalize">{f.fieldType}</TableCell>
               <TableCell className="text-sm text-muted-foreground">
                 {f.fieldType === 'calculable' ? `$${f.pricePerUnit ?? 0} per ${f.unitSize ?? 1} units` : 'Informational'}
               </TableCell>
               <TableCell>{f.sortOrder ?? '—'}</TableCell>
               <TableCell className="text-right whitespace-nowrap">
                 <Button variant="ghost" size="sm" onClick={() => setEditing({
                   id: f.id,
                   form: { label: f.label, fieldType: f.fieldType, pricePerUnit: f.pricePerUnit ?? null, unitSize: f.unitSize ?? null, sortOrder: f.sortOrder ?? null },
                 })}>Edit</Button>
                 <Button variant="ghost" size="icon" className="text-destructive" onClick={() => {
                   if (confirm(`Delete field "${f.label}"? Existing estimates keep their saved lines.`)) {
                     deleteField.mutate({ id: f.id }, { onSuccess: invalidate });
                   }
                 }}>
                   <Trash2 className="w-4 h-4" />
                 </Button>
               </TableCell>
             </TableRow>
           ))}
         </TableBody>
       </Table>
      }

      <Dialog open={!!editing} onOpenChange={open => !open && setEditing(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editing?.id == null ? 'Add Field' : 'Edit Field'}</DialogTitle>
          </DialogHeader>
          {editing && (
            <div className="space-y-4">
              <div>
                <label className="text-sm font-medium mb-1 block">Label</label>
                <Input value={editing.form.label} placeholder="e.g. Turf Sqft"
                  onChange={e => setEditing(prev => prev && ({ ...prev, form: { ...prev.form, label: e.target.value } }))} />
              </div>
              <div>
                <label className="text-sm font-medium mb-1 block">Type</label>
                <select
                  className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                  value={editing.form.fieldType}
                  onChange={e => setEditing(prev => prev && ({ ...prev, form: { ...prev.form, fieldType: e.target.value as EstimateFieldInput['fieldType'] } }))}
                >
                  <option value="calculable">Calculable (prices a line item)</option>
                  <option value="number">Number (informational)</option>
                  <option value="text">Text (informational)</option>
                  <option value="boolean">Yes / No (informational)</option>
                </select>
              </div>
              {editing.form.fieldType === 'calculable' && (
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="text-sm font-medium mb-1 block">Price per unit ($)</label>
                    <Input type="number" min="0" step="0.01" {...formNumber('pricePerUnit')} />
                  </div>
                  <div>
                    <label className="text-sm font-medium mb-1 block">Unit size</label>
                    <Input type="number" min="0" step="1" placeholder="e.g. 1000" {...formNumber('unitSize')} />
                  </div>
                  <p className="text-xs text-muted-foreground col-span-2">
                    Example: $20 per 1000 sqft → price per unit 20, unit size 1000. A 6200 sqft value prices at $124.
                  </p>
                </div>
              )}
              <div>
                <label className="text-sm font-medium mb-1 block">Sort order</label>
                <Input type="number" className="w-32" {...formNumber('sortOrder')} />
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditing(null)}>Cancel</Button>
            <Button disabled={!editing?.form.label.trim() || createField.isPending || updateField.isPending} onClick={saveForm}>
              {editing?.id == null ? 'Create Field' : 'Save Changes'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

type PresetForm = { label: string; price: string };

/**
 * Office-wide templates for the one-off charges typed into an estimate's Custom
 * Lines. A preset is copied when inserted, never linked, so renaming or deleting
 * one here leaves every estimate already built or sent exactly as it was.
 */
function ChargePresets() {
  const { data: presets, isLoading } = useListChargePresets();
  const createPreset = useCreateChargePreset();
  const updatePreset = useUpdateChargePreset();
  const deletePreset = useDeleteChargePreset();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<{ id: number | null; form: PresetForm } | null>(null);
  const [error, setError] = useState('');
  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['/api/charge-presets'] });

  const label = editing?.form.label.trim() ?? '';
  const price = customLinePrice(editing?.form.price ?? '');
  const canSave = label !== '' && price != null;

  const saveForm = () => {
    if (!editing || !canSave) return;
    setError('');
    const data = { label, defaultPrice: price! };
    const done = {
      onSuccess: () => { invalidate(); setEditing(null); },
      // The server applies the same label/price rules as a custom estimate line,
      // so anything it rejects is shown here rather than silently discarded.
      onError: (err: unknown) => setError(err instanceof Error ? err.message : 'Could not save this preset'),
    };
    if (editing.id == null) createPreset.mutate({ data }, done);
    else updatePreset.mutate({ id: editing.id, data }, done);
  };

  const openEditor = (preset: ChargePreset | null) => {
    setError('');
    setEditing(preset
      ? { id: preset.id, form: { label: preset.label, price: String(preset.defaultPrice) } }
      : { id: null, form: { label: '', price: '' } });
  };

  return (
    <div className="bg-card border rounded-lg shadow-sm flex-1 overflow-auto h-full p-6 space-y-4">
      <div className="flex justify-between items-center">
        <div>
          <h2 className="text-xl font-bold">Charge Presets</h2>
          <p className="text-sm text-muted-foreground">
            Reusable one-off charges like Haul-away, Dump fee, or a seasonal discount (use a negative price).
            Inserting one copies its label and price onto the estimate, where the price stays editable.
          </p>
        </div>
        <Button onClick={() => openEditor(null)}>
          <Plus className="w-4 h-4 mr-2" /> Add Preset
        </Button>
      </div>

      {isLoading ? <div>Loading...</div> :
       !presets?.length ? <div className="text-sm text-muted-foreground">No charge presets yet.</div> :
       <Table>
         <TableHeader>
           <TableRow>
             <TableHead>Label</TableHead>
             <TableHead>Default price</TableHead>
             <TableHead className="w-24"></TableHead>
           </TableRow>
         </TableHeader>
         <TableBody>
           {presets.map(p => (
             <TableRow key={p.id}>
               <TableCell className="font-medium">{p.label}</TableCell>
               <TableCell className="tabular-nums">{money(p.defaultPrice)}</TableCell>
               <TableCell className="text-right whitespace-nowrap">
                 <Button variant="ghost" size="sm" onClick={() => openEditor(p)}>Edit</Button>
                 <Button variant="ghost" size="icon" className="text-destructive" onClick={() => {
                   if (confirm(`Delete preset "${p.label}"? Estimates that already use it keep their saved lines.`)) {
                     deletePreset.mutate({ id: p.id }, { onSuccess: invalidate });
                   }
                 }}>
                   <Trash2 className="w-4 h-4" />
                 </Button>
               </TableCell>
             </TableRow>
           ))}
         </TableBody>
       </Table>
      }

      <Dialog open={!!editing} onOpenChange={open => !open && setEditing(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editing?.id == null ? 'Add Charge Preset' : 'Edit Charge Preset'}</DialogTitle>
          </DialogHeader>
          {editing && (
            <div className="space-y-4">
              <div>
                <label className="text-sm font-medium mb-1 block">Label</label>
                <Input
                  value={editing.form.label}
                  placeholder="e.g. Haul-away"
                  onChange={e => setEditing(prev => prev && ({ ...prev, form: { ...prev.form, label: e.target.value } }))}
                />
              </div>
              <div>
                <label className="text-sm font-medium mb-1 block">Default price ($)</label>
                <Input
                  type="number"
                  step="0.01"
                  className="w-40"
                  value={editing.form.price}
                  placeholder="75.00"
                  onChange={e => setEditing(prev => prev && ({ ...prev, form: { ...prev.form, price: e.target.value } }))}
                />
                <p className="text-xs text-muted-foreground mt-1">
                  Use a negative amount for a discount. This is only a starting value — the price can be changed on each estimate.
                </p>
              </div>
              {editing.id != null && (
                <p className="text-xs text-muted-foreground">
                  Renaming or repricing this preset only affects charges inserted from now on. Estimates already built keep what they were saved with.
                </p>
              )}
              {error && (
                <div className="flex gap-2 rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
                  <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                  <span>{error}</span>
                </div>
              )}
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditing(null)}>Cancel</Button>
            <Button disabled={!canSave || createPreset.isPending || updatePreset.isPending} onClick={saveForm}>
              {editing?.id == null ? 'Create Preset' : 'Save Changes'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/** A 409 raised because another admin saved a newer version of the same draft. */
function readVersionConflict(error: unknown): VersionConflict | null {
  if (!error || typeof error !== 'object') return null;
  const { status, data } = error as { status?: number; data?: unknown };
  if (status !== 409 || !data || typeof data !== 'object') return null;
  const body = data as { error?: string; code?: string; current?: Estimate };
  if (body.code !== 'estimate_version_conflict') return null;
  return {
    message: body.error ?? 'Someone else saved changes to this estimate while you were editing.',
    current: body.current ?? null,
  };
}

function selectionFromStored(stored: StoredSelection[] | undefined): SelectionState {
  const state: SelectionState = {};
  for (const entry of stored ?? []) state[entry.id] = { selected: entry.selected, value: entry.value };
  return state;
}
