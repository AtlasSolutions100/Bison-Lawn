import { useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  useListClientTags,
  useCreateClientTag,
  useUpdateClientTag,
  useDeleteClientTag,
  getListClientTagsQueryKey,
  type ClientTag,
} from '@workspace/api-client-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { useToast } from '@/hooks/use-toast';
import { Check, Pencil, Plus, Tag, Trash2, X } from 'lucide-react';

/**
 * Tags, picked off a list instead of typed.
 *
 * "Create a tag list for drop down selection, ability to add multiple tags."
 * Typing the tag each time made a second tag out of every typo — "backflow"
 * and "backflo" one under the other in the filter, looking identical from
 * across the desk — and the only way to notice was to go looking.
 *
 * So the list is a thing now: he ticks as many as he wants off it, and putting
 * a NEW tag on the list is its own button with the word spelled out next to it.
 * Every tag already on his 709 customers is on the list from the start, whether
 * anybody added it or not, so nothing the import brought in went missing.
 *
 * Renaming a tag fixes it on every customer carrying it, which is the only way
 * a typo that is already out there ever gets cleaned up.
 */

const tidy = (name: string) => name.trim().toLowerCase().replace(/\s+/g, ' ');

export default function TagPicker({ tags, onChange, saving }: {
  /** The tags on this customer right now. */
  tags: string[];
  /** Called with the whole new list for this customer; the caller saves it. */
  onChange: (next: string[]) => void;
  saving?: boolean;
}) {
  const [open, setOpen] = useState(false);

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {tags.map(tag => (
        <span
          key={tag}
          className="inline-flex items-center gap-1 rounded-full border bg-background px-2 py-0.5 text-xs"
          data-testid={`tag-${tag}`}
        >
          {tag}
          <button
            type="button"
            onClick={() => onChange(tags.filter(t => t !== tag))}
            className="text-muted-foreground hover:text-destructive"
            aria-label={`Remove tag ${tag}`}
            disabled={saving}
          >
            <X className="w-3 h-3" />
          </button>
        </span>
      ))}
      <Button
        type="button"
        size="sm"
        variant="outline"
        className="h-7 px-2 text-xs"
        onClick={() => setOpen(true)}
        data-testid="tag-picker-open"
      >
        <Tag className="w-3 h-3 mr-1" /> {tags.length ? 'Tags' : 'Add a tag'}
      </Button>
      <TagPickerDialog open={open} onOpenChange={setOpen} tags={tags} onChange={onChange} saving={saving} />
    </div>
  );
}

function TagPickerDialog({ open, onOpenChange, tags, onChange, saving }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  tags: string[];
  onChange: (next: string[]) => void;
  saving?: boolean;
}) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { data: list, isLoading } = useListClientTags({ query: { enabled: open, queryKey: getListClientTagsQueryKey() } });
  const createTag = useCreateClientTag();
  const updateTag = useUpdateClientTag();
  const deleteTag = useDeleteClientTag();
  const [search, setSearch] = useState('');
  const [manage, setManage] = useState(false);
  const [renaming, setRenaming] = useState<{ id: number; name: string } | null>(null);

  const refresh = () => queryClient.invalidateQueries({ queryKey: getListClientTagsQueryKey() });
  const failed = (title: string) => (err: any) =>
    toast({ title, description: err?.data?.error ?? err?.message ?? 'Please try again.', variant: 'destructive' });

  const typed = tidy(search);
  const visible = useMemo(() => {
    const rows = list ?? [];
    if (!typed) return rows;
    return rows.filter(t => t.name.includes(typed));
  }, [list, typed]);
  // Only offer to add what is not already there, so the button cannot be used
  // to make a duplicate of a tag that is one line above it.
  const canAdd = typed.length > 0 && !(list ?? []).some(t => t.name === typed);

  const toggle = (name: string) =>
    onChange(tags.includes(name) ? tags.filter(t => t !== name) : [...tags, name]);

  const addToList = () => {
    if (!canAdd) return;
    createTag.mutate({ data: { name: typed } }, {
      onSuccess: () => {
        refresh();
        // Added from a customer's page, so it goes on that customer too — that
        // is why he was typing it.
        if (!tags.includes(typed)) onChange([...tags, typed]);
        setSearch('');
        toast({ title: `"${typed}" added to the tag list` });
      },
      onError: failed('Could not add that tag'),
    });
  };

  /**
   * A tag that came in on the customers and was never on the list: putting it
   * on the list is what makes its spelling fixable, so the typos the import
   * brought with it are not stuck forever. It does not tag this customer —
   * nobody pressed it to say "and this one too".
   */
  const adopt = (name: string) => {
    createTag.mutate({ data: { name } }, {
      onSuccess: () => { refresh(); toast({ title: `"${name}" is on the list now` }); },
      onError: failed('Could not add that tag to the list'),
    });
  };

  const rename = () => {
    if (!renaming) return;
    const name = tidy(renaming.name);
    if (!name) return;
    const was = (list ?? []).find(t => t.id === renaming.id)?.name;
    updateTag.mutate({ id: renaming.id, data: { name } }, {
      onSuccess: () => {
        refresh();
        // Every customer carrying this tag just changed spelling, not only the
        // one on screen, so anything already fetched under /api/clients is
        // stale — otherwise the chips still read the typo until a reload.
        queryClient.invalidateQueries({
          predicate: q => String(q.queryKey[0] ?? '').startsWith('/api/clients'),
        });
        // This customer may already carry the spelling we just renamed TO, so
        // the swap has to leave one chip, not the same word twice — the server
        // leaves one tag on him, and the picker has to agree with it.
        if (was && tags.includes(was)) {
          onChange([...new Set(tags.map(t => (t === was ? name : t)))]);
        }
        setRenaming(null);
        toast({ title: `Renamed to "${name}" everywhere it was used` });
      },
      onError: failed('Could not rename that tag'),
    });
  };

  const remove = (tag: ClientTag) => {
    if (tag.id == null) return;
    deleteTag.mutate({ id: tag.id }, {
      onSuccess: () => { refresh(); toast({ title: `"${tag.name}" taken off the list` }); },
      onError: failed('Could not take that tag off the list'),
    });
  };

  const busy = saving || createTag.isPending || updateTag.isPending || deleteTag.isPending;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[520px]">
        <DialogHeader>
          <DialogTitle>Tags</DialogTitle>
          <DialogDescription>
            Tick as many as fit this customer. Everything already used on a customer is on the list, so a new
            tag only appears when you add it on purpose.
          </DialogDescription>
        </DialogHeader>

        <Input
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Find a tag, or type a new one"
          onKeyDown={e => { if (e.key === 'Enter' && canAdd) { e.preventDefault(); addToList(); } }}
          data-testid="tag-picker-search"
        />

        <div className="max-h-72 overflow-y-auto rounded-md border divide-y" data-testid="tag-picker-list">
          {isLoading ? (
            <p className="p-3 text-sm text-muted-foreground animate-pulse">Loading the tag list...</p>
          ) : visible.length === 0 ? (
            <p className="p-3 text-sm text-muted-foreground">
              {typed ? `No tag like "${typed}" yet.` : 'No tags yet. Type one above and add it to the list.'}
            </p>
          ) : visible.map(tag => {
            const on = tags.includes(tag.name);
            if (renaming?.id != null && renaming.id === tag.id) {
              return (
                <div key={tag.name} className="flex items-center gap-2 p-2">
                  <Input
                    className="h-8"
                    value={renaming.name}
                    autoFocus
                    onChange={e => setRenaming({ id: renaming.id, name: e.target.value })}
                    onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); rename(); } }}
                    data-testid="tag-rename-input"
                  />
                  <Button size="sm" className="h-8" disabled={busy} onClick={rename} data-testid="tag-rename-save">Save</Button>
                  <Button size="sm" variant="ghost" className="h-8" onClick={() => setRenaming(null)}>Cancel</Button>
                </div>
              );
            }
            return (
              <div key={tag.name} className="flex items-center gap-2 p-2">
                <button
                  type="button"
                  className="flex min-w-0 flex-1 items-center gap-2 text-left text-sm"
                  disabled={busy}
                  onClick={() => toggle(tag.name)}
                  data-testid={`tag-pick-${tag.name}`}
                >
                  <span className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border ${on ? 'bg-primary border-primary text-primary-foreground' : 'bg-background'}`}>
                    {on && <Check className="w-3 h-3" />}
                  </span>
                  <span className={`truncate ${on ? 'font-medium' : ''}`}>{tag.name}</span>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {tag.count === 0 ? 'not used yet' : `${tag.count} ${tag.count === 1 ? 'customer' : 'customers'}`}
                  </span>
                </button>
                {manage && (
                  tag.id == null ? (
                    // A tag that only exists on customers has no list row to
                    // rename or delete. Saying so beats two buttons that do
                    // nothing.
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 shrink-0 px-2 text-xs"
                      disabled={busy}
                      title="This one came in on the customers. Put it on the list and you can fix its spelling."
                      onClick={() => adopt(tag.name)}
                      data-testid={`tag-adopt-${tag.name}`}
                    >
                      Add to list
                    </Button>
                  ) : (
                    <div className="flex shrink-0 items-center gap-1">
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-7 w-7"
                        aria-label={`Rename ${tag.name}`}
                        disabled={busy}
                        onClick={() => setRenaming({ id: tag.id!, name: tag.name })}
                        data-testid={`tag-rename-${tag.name}`}
                      >
                        <Pencil className="w-3.5 h-3.5" />
                      </Button>
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-7 w-7 text-muted-foreground hover:text-destructive"
                        aria-label={`Take ${tag.name} off the list`}
                        disabled={busy}
                        onClick={() => remove(tag)}
                        data-testid={`tag-delete-${tag.name}`}
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </Button>
                    </div>
                  )
                )}
              </div>
            );
          })}
        </div>

        {canAdd && (
          <Button type="button" variant="secondary" disabled={busy} onClick={addToList} data-testid="tag-picker-add">
            <Plus className="w-4 h-4 mr-1" /> Add "{typed}" to the list and tag this customer
          </Button>
        )}

        <DialogFooter className="sm:justify-between">
          <Button type="button" variant="ghost" onClick={() => { setManage(!manage); setRenaming(null); }} data-testid="tag-picker-manage">
            {manage ? 'Done editing the list' : 'Fix a spelling or remove one'}
          </Button>
          <Button type="button" onClick={() => onOpenChange(false)}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
