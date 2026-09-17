import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  useListProductPresets,
  getListProductPresetsQueryKey,
  useCreateProductPreset,
  useUpdateProductPreset,
  useDeleteProductPreset,
  type ProductPreset,
} from '@workspace/api-client-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { useToast } from '@/hooks/use-toast';
import { Plus, Trash2, Wrench } from 'lucide-react';

/**
 * The parts and fees list: bag fee, sprinkler head, valve, the things a
 * contractor adds to a job with a count. The price is the office's; the crew
 * only says how many. "Crew may add" is the switch that puts a part on their
 * phone at all — a $400 valve stays office-only.
 */

type Draft = { label: string; defaultPrice: string; unit: string; contractorCanAdd: boolean };
const EMPTY: Draft = { label: '', defaultPrice: '', unit: '', contractorCanAdd: true };

const errText = (e: unknown, fallback: string) => {
  const err = e as { data?: { error?: string }; message?: string } | null;
  return err?.data?.error || err?.message || fallback;
};

function PresetRow({ preset }: { preset: ProductPreset }) {
  const update = useUpdateProductPreset();
  const remove = useDeleteProductPreset();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [label, setLabel] = useState(preset.label);
  const [price, setPrice] = useState(String(preset.defaultPrice));
  const [unit, setUnit] = useState(preset.unit ?? '');
  const refresh = () => queryClient.invalidateQueries({ queryKey: getListProductPresetsQueryKey() });
  const fail = (e: unknown) => toast({ title: 'Could not save the part', description: errText(e, ''), variant: 'destructive' });

  const dirty = label.trim() !== preset.label || Number(price) !== preset.defaultPrice || (unit.trim() || null) !== (preset.unit ?? null);

  const save = () => {
    update.mutate(
      { id: preset.id, data: { label: label.trim(), defaultPrice: Number(price) || 0, unit: unit.trim() || null } },
      { onSuccess: refresh, onError: fail },
    );
  };

  return (
    <div className="grid grid-cols-12 items-center gap-2 py-2">
      <Input className="col-span-5 h-9" value={label} onChange={e => setLabel(e.target.value)} />
      <Input className="col-span-2 h-9" type="number" step="0.01" min="0" value={price} onChange={e => setPrice(e.target.value)} />
      <Input className="col-span-2 h-9" placeholder="each" value={unit} onChange={e => setUnit(e.target.value)} />
      <label className="col-span-2 flex items-center gap-2 text-xs">
        <Switch
          checked={preset.contractorCanAdd}
          onCheckedChange={v => update.mutate({ id: preset.id, data: { contractorCanAdd: v } }, { onSuccess: refresh, onError: fail })}
        />
        crew may add
      </label>
      <div className="col-span-1 flex justify-end gap-1">
        {dirty && <Button size="sm" className="h-8" onClick={save} disabled={update.isPending}>Save</Button>}
        <Button
          size="icon"
          variant="ghost"
          className="h-8 w-8 text-muted-foreground hover:text-destructive"
          onClick={() => {
            if (!window.confirm(`Take "${preset.label}" off the list? Jobs that already have it keep their line.`)) return;
            remove.mutate({ id: preset.id }, { onSuccess: refresh, onError: fail });
          }}
        >
          <Trash2 className="w-4 h-4" />
        </Button>
      </div>
    </div>
  );
}

export default function ProductPresets() {
  const { data: presets, isLoading } = useListProductPresets();
  const create = useCreateProductPreset();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [draft, setDraft] = useState<Draft>(EMPTY);

  const add = (e: React.FormEvent) => {
    e.preventDefault();
    create.mutate(
      { data: { label: draft.label.trim(), defaultPrice: Number(draft.defaultPrice) || 0, unit: draft.unit.trim() || null, contractorCanAdd: draft.contractorCanAdd } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListProductPresetsQueryKey() });
          setDraft(EMPTY);
        },
        onError: (err) => toast({ title: 'Could not add the part', description: errText(err, ''), variant: 'destructive' }),
      },
    );
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><Wrench className="w-5 h-5 text-muted-foreground" /> Parts and fees</CardTitle>
        <CardDescription>
          What a contractor can add to a job with a count — a bag fee, a sprinkler head. The total goes straight onto the invoice.
          Switch off “crew may add” to keep a part office-only.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {isLoading ? (
          <p className="text-sm text-muted-foreground animate-pulse">Loading…</p>
        ) : (
          <div>
            <div className="grid grid-cols-12 gap-2 text-[11px] font-bold uppercase tracking-wider text-muted-foreground pb-1 border-b">
              <span className="col-span-5">Part or fee</span>
              <span className="col-span-2">Price</span>
              <span className="col-span-2">Unit</span>
              <span className="col-span-3"></span>
            </div>
            {!presets?.length ? (
              <p className="text-sm text-muted-foreground py-3">Nothing on the list yet.</p>
            ) : (
              <div className="divide-y">{presets.map(p => <PresetRow key={p.id} preset={p} />)}</div>
            )}
          </div>
        )}
        <form onSubmit={add} className="grid grid-cols-12 items-end gap-2 rounded-lg border bg-muted/30 p-3">
          <div className="col-span-5">
            <Label className="text-xs">New part or fee</Label>
            <Input className="h-9" placeholder="Bag fee" value={draft.label} onChange={e => setDraft(d => ({ ...d, label: e.target.value }))} required />
          </div>
          <div className="col-span-2">
            <Label className="text-xs">Price</Label>
            <Input className="h-9" type="number" step="0.01" min="0" value={draft.defaultPrice} onChange={e => setDraft(d => ({ ...d, defaultPrice: e.target.value }))} required />
          </div>
          <div className="col-span-2">
            <Label className="text-xs">Unit</Label>
            <Input className="h-9" placeholder="bag" value={draft.unit} onChange={e => setDraft(d => ({ ...d, unit: e.target.value }))} />
          </div>
          <label className="col-span-2 flex items-center gap-2 text-xs pb-2">
            <Switch checked={draft.contractorCanAdd} onCheckedChange={v => setDraft(d => ({ ...d, contractorCanAdd: v }))} /> crew may add
          </label>
          <div className="col-span-1 flex justify-end">
            <Button type="submit" size="sm" className="h-9" disabled={create.isPending || !draft.label.trim()}><Plus className="w-4 h-4" /></Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
