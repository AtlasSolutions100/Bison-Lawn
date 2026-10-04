import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  useListCustomerFields,
  useCreateCustomerField,
  useUpdateCustomerField,
  useDeleteCustomerField,
  CustomerFieldInputFieldType,
  type CustomerField,
  type CustomerFieldInputFieldType as FieldType,
} from '@workspace/api-client-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useToast } from '@/hooks/use-toast';
import { ListChecks, Plus, Trash2 } from 'lucide-react';

/**
 * "Add Customer Field Effects all Clients."
 *
 * What went wrong for him: the box at the bottom of a customer's Custom fields
 * card adds a label to THAT customer and nowhere else, so the field he added
 * for one house was missing from the next 708. The list below is the one that
 * shows on every customer — the same fields the estimate builder and the rate
 * matrix read — and until now there was no way to add to it from Settings.
 *
 * The second list is the honest part: every label that exists on one customer
 * only. One click puts it on everybody, keeping the values already saved.
 */

const FIELD_TYPE_LABEL: Record<string, string> = {
  calculable: 'Number the matrix can price from',
  number: 'Number',
  text: 'Text',
  boolean: 'Yes / no',
};

const selectClass = 'flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm';

const errText = (e: unknown, fallback: string) => {
  const err = e as { data?: { error?: string }; message?: string } | null;
  return err?.data?.error || err?.message || fallback;
};

function FieldRow({ field, clientCount }: { field: CustomerField; clientCount: number }) {
  const update = useUpdateCustomerField();
  const remove = useDeleteCustomerField();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [label, setLabel] = useState(field.label);

  const refresh = () => queryClient.invalidateQueries({ queryKey: ['/api/customer-fields'] });
  const fail = (e: unknown) => toast({ title: 'Could not save the field', description: errText(e, ''), variant: 'destructive' });
  const dirty = label.trim() !== field.label && label.trim() !== '';

  const rename = () => {
    update.mutate({ id: field.id, data: { label: label.trim() } }, {
      onSuccess: (saved) => {
        refresh();
        const moved = (saved as { movedValues?: number | null }).movedValues ?? 0;
        if (moved) {
          toast({ title: 'Field renamed', description: `What ${moved} customer${moved === 1 ? '' : 's'} had saved under it came across.` });
        }
      },
      onError: fail,
    });
  };

  return (
    <div className="grid grid-cols-12 items-center gap-2 py-2" data-testid={`customer-field-row-${field.id}`}>
      <Input
        className="col-span-5 h-9"
        value={label}
        onChange={e => setLabel(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter' && dirty) rename(); }}
      />
      <div className="col-span-4">
        <select
          className={selectClass}
          value={field.fieldType}
          onChange={e => update.mutate({ id: field.id, data: { fieldType: e.target.value as FieldType } }, { onSuccess: refresh, onError: fail })}
        >
          {Object.entries(FIELD_TYPE_LABEL).map(([value, text]) => (
            <option key={value} value={value}>{text}</option>
          ))}
        </select>
      </div>
      <span className="col-span-2 text-xs text-muted-foreground">
        {field.filledCount} of {clientCount} filled in
      </span>
      <div className="col-span-1 flex justify-end gap-1">
        {dirty && <Button size="sm" className="h-8" onClick={rename} disabled={update.isPending}>Save</Button>}
        <Button
          size="icon"
          variant="ghost"
          className="h-8 w-8 text-muted-foreground hover:text-destructive"
          aria-label={`Remove ${field.label}`}
          onClick={() => {
            const warning = field.filledCount
              ? `Stop asking every customer for "${field.label}"? The ${field.filledCount} who already have a value keep it.`
              : `Stop asking every customer for "${field.label}"?`;
            if (!window.confirm(warning)) return;
            remove.mutate({ id: field.id }, { onSuccess: refresh, onError: fail });
          }}
        >
          <Trash2 className="w-4 h-4" />
        </Button>
      </div>
    </div>
  );
}

export default function CustomerFields() {
  const { data, isLoading } = useListCustomerFields();
  const create = useCreateCustomerField();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [label, setLabel] = useState('');
  const [fieldType, setFieldType] = useState<FieldType>(CustomerFieldInputFieldType.text);

  const refresh = () => queryClient.invalidateQueries({ queryKey: ['/api/customer-fields'] });
  const clientCount = data?.clientCount ?? 0;

  const addField = (nextLabel: string, nextType: FieldType, onDone?: () => void) => {
    create.mutate({ data: { label: nextLabel, fieldType: nextType } }, {
      onSuccess: (saved) => {
        refresh();
        onDone?.();
        const kept = (saved as { filledCount?: number }).filledCount ?? 0;
        toast({
          title: `"${nextLabel}" now shows on every customer`,
          description: kept ? `The ${kept} customer${kept === 1 ? '' : 's'} who already had a value for it keep it.` : undefined,
        });
      },
      onError: (err) => toast({ title: 'Could not add the field', description: errText(err, ''), variant: 'destructive' }),
    });
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><ListChecks className="w-5 h-5 text-muted-foreground" /> Customer fields</CardTitle>
        <CardDescription>
          Add a field here and it shows on every customer — all {clientCount || 'your'} of them — on the estimate builder,
          and on the crew's job card. A field added from one customer's page only ever belonged to that customer; this is the list that covers everybody.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {isLoading ? (
          <p className="text-sm text-muted-foreground animate-pulse">Loading…</p>
        ) : (
          <div>
            <div className="grid grid-cols-12 gap-2 border-b pb-1 text-[11px] font-bold uppercase tracking-wider text-muted-foreground">
              <span className="col-span-5">Field</span>
              <span className="col-span-4">Kind of answer</span>
              <span className="col-span-3">On how many</span>
            </div>
            {!data?.managed.length ? (
              <p className="py-3 text-sm text-muted-foreground">Nothing on the list yet.</p>
            ) : (
              <div className="divide-y" data-testid="customer-field-list">
                {data.managed.map(f => <FieldRow key={f.id} field={f} clientCount={clientCount} />)}
              </div>
            )}
          </div>
        )}

        <form
          onSubmit={(e) => { e.preventDefault(); addField(label.trim(), fieldType, () => setLabel('')); }}
          className="grid grid-cols-12 items-end gap-2 rounded-lg border bg-muted/30 p-3"
        >
          <div className="col-span-6">
            <Label className="text-xs">New field for every customer</Label>
            <Input className="h-9" placeholder="Gate code" value={label} onChange={e => setLabel(e.target.value)} data-testid="customer-field-new" required />
          </div>
          <div className="col-span-5">
            <Label className="text-xs">Kind of answer</Label>
            <select className={selectClass} value={fieldType} onChange={e => setFieldType(e.target.value as FieldType)}>
              {Object.entries(FIELD_TYPE_LABEL).map(([value, text]) => (
                <option key={value} value={value}>{text}</option>
              ))}
            </select>
          </div>
          <div className="col-span-1 flex justify-end">
            <Button type="submit" size="sm" className="h-9" disabled={create.isPending || !label.trim()}>
              <Plus className="w-4 h-4" />
            </Button>
          </div>
        </form>

        {data?.unmanaged.length ? (
          <div className="rounded-lg border p-3" data-testid="customer-field-strays">
            <h3 className="text-sm font-semibold">Fields on one customer only</h3>
            <p className="mt-1 text-sm text-muted-foreground">
              These were typed on a single customer's page, so they only show there. Add one and it appears on every
              customer, and whoever already has a value for it keeps it.
            </p>
            <div className="mt-3 space-y-2">
              {data.unmanaged.map(entry => (
                <div key={entry.label} className="flex items-center justify-between gap-3 text-sm">
                  <span>
                    <strong>{entry.label}</strong>
                    <span className="text-muted-foreground"> — on {entry.filled} customer{entry.filled === 1 ? '' : 's'}</span>
                  </span>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-8"
                    disabled={create.isPending}
                    onClick={() => addField(entry.label, CustomerFieldInputFieldType.text)}
                  >
                    Add to every customer
                  </Button>
                </div>
              ))}
            </div>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
