import { useMemo, useState } from 'react';
import {
  useListUsers, useUpdateUser, useDeleteUser,
  useListInvitations, useCreateInvitation, useRevokeInvitation, useResendInvitation,
  type AppUser, type AccessLevel,
} from '@workspace/api-client-react';
import { useQueryClient } from '@tanstack/react-query';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { Switch } from '@/components/ui/switch';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Edit2, Mail, Trash2, X } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { AREAS, AREA_LABELS, LEVELS, OFFICE_BASE, useMe, type Area } from '@/lib/access';
import { SmsNumberField } from '@/components/sms-status-card';

type Filter = 'active' | 'inactive' | 'all';

/**
 * The areas a person can open, worked out the same way the server does it.
 * Used to seed the checkboxes; the server's `areas` is the truth for display.
 */
function allowedAreas(level: AccessLevel, permissions: string[]): Set<Area> {
  const denied = new Set(permissions.filter(p => p.startsWith('!')).map(p => p.slice(1)));
  const granted = new Set(permissions.filter(p => !p.startsWith('!')));
  const out = new Set<Area>();
  if (level === 'mobile') return out;
  for (const area of AREAS) {
    const base = level === 'full' || OFFICE_BASE.includes(area);
    if ((base || granted.has(area)) && !denied.has(area)) out.add(area);
  }
  return out;
}

/** The checkbox picture, turned back into the grants/denials the server stores. */
function permissionsFor(level: AccessLevel, allowed: Set<Area>): string[] {
  if (level === 'mobile') return [];
  const out: string[] = [];
  for (const area of AREAS) {
    const base = level === 'full' || OFFICE_BASE.includes(area);
    if (base && !allowed.has(area)) out.push(`!${area}`);
    if (!base && allowed.has(area)) out.push(area);
  }
  return out;
}

function levelLabel(level: string) {
  return LEVELS.find(l => l.value === level)?.label ?? level;
}

/** "Full user, no QuickBooks" / "Office user, plus Reports" — the one-line summary in the table. */
function accessSummary(user: AppUser): string {
  if (user.roleSource === 'owner') return 'Owner (everything)';
  const denied = (user.permissions ?? []).filter(p => p.startsWith('!')).map(p => AREA_LABELS[p.slice(1) as Area] ?? p.slice(1));
  const granted = (user.permissions ?? []).filter(p => !p.startsWith('!')).map(p => AREA_LABELS[p as Area] ?? p);
  const bits = [levelLabel(user.accessLevel)];
  if (granted.length) bits.push(`plus ${granted.join(', ')}`);
  if (denied.length) bits.push(`no ${denied.join(', ')}`);
  return bits.join(', ');
}

function fmtDate(value: string | null | undefined) {
  if (!value) return '-';
  const [y, m, d] = value.split('-');
  return y && m && d ? `${Number(m)}/${Number(d)}/${y}` : value;
}

export default function Team() {
  const { data: users, isLoading } = useListUsers({ includeInactive: true });
  const [filter, setFilter] = useState<Filter>('active');
  const [editing, setEditing] = useState<AppUser | null>(null);

  const shown = useMemo(() => {
    const list = users ?? [];
    if (filter === 'all') return list;
    return list.filter(u => (filter === 'active' ? u.active : !u.active));
  }, [users, filter]);

  const counts = useMemo(() => ({
    active: (users ?? []).filter(u => u.active).length,
    inactive: (users ?? []).filter(u => !u.active).length,
  }), [users]);

  return (
    <div className="p-8 max-w-6xl mx-auto space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Team</h1>
        {/* His words: full user, partial (office) user, mobile only. One line
            each so he never has to guess what a level lets someone do. */}
        <p className="text-muted-foreground mt-1">
          Everyone who signs in, and what each person can open. You can have as many full users as you like.
        </p>
        <ul className="mt-3 grid gap-2 sm:grid-cols-3 text-sm">
          {LEVELS.map(l => (
            <li key={l.value} className="rounded-md border bg-card px-3 py-2">
              <div className="font-semibold">{l.label}</div>
              <div className="text-muted-foreground">{l.explain}</div>
            </li>
          ))}
        </ul>
      </div>

      <div className="bg-card border rounded-lg shadow-sm">
        <div className="flex items-center gap-1 p-2 border-b">
          {([['active', `Active (${counts.active})`], ['inactive', `Inactive (${counts.inactive})`], ['all', 'All']] as [Filter, string][]).map(([key, label]) => (
            <Button
              key={key}
              size="sm"
              variant={filter === key ? 'default' : 'ghost'}
              onClick={() => setFilter(key)}
              data-testid={`team-filter-${key}`}
            >
              {label}
            </Button>
          ))}
        </div>
        <div className="overflow-auto">
          <Table>
            <TableHeader className="bg-muted/50">
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Access</TableHead>
                <TableHead>Phone</TableHead>
                <TableHead>Birthday</TableHead>
                <TableHead>Hired</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="w-16"></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                <TableRow><TableCell colSpan={7} className="text-center py-4">Loading...</TableCell></TableRow>
              ) : !shown.length ? (
                <TableRow><TableCell colSpan={7} className="text-center py-4">Nobody here.</TableCell></TableRow>
              ) : (
                shown.map(u => (
                  <TableRow key={u.id} className={`hover:bg-muted/50 ${u.active ? '' : 'opacity-60'}`} data-testid={`team-row-${u.id}`}>
                    <TableCell>
                      <div className="font-semibold">{u.name}</div>
                      <div className="text-xs text-muted-foreground">
                        {u.fullName && u.fullName !== u.name ? `${u.fullName} · ` : ''}{u.email || 'no email'}
                      </div>
                    </TableCell>
                    <TableCell>
                      <span className={`px-2 py-0.5 rounded text-xs font-bold uppercase ${u.accessLevel === 'mobile' ? 'bg-accent text-accent-foreground' : 'bg-primary text-primary-foreground'}`}>
                        {levelLabel(u.accessLevel)}
                      </span>
                      <div className="text-xs text-muted-foreground mt-1">{accessSummary(u)}</div>
                    </TableCell>
                    <TableCell className="text-muted-foreground">{u.phone || '-'}</TableCell>
                    <TableCell className="text-muted-foreground">{fmtDate(u.birthday)}</TableCell>
                    <TableCell className="text-muted-foreground">{fmtDate(u.hireDate)}</TableCell>
                    <TableCell>
                      {u.active
                        ? <span className="text-xs font-medium text-green-700 dark:text-green-500">Active</span>
                        : <span className="text-xs font-medium text-muted-foreground">Turned off</span>}
                    </TableCell>
                    <TableCell className="text-right">
                      <Button size="icon" variant="ghost" className="h-8 w-8 text-muted-foreground hover:text-primary" onClick={() => setEditing(u)} data-testid={`team-edit-${u.id}`}>
                        <Edit2 className="w-4 h-4" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      </div>

      {editing && <EditPersonDialog user={editing} onClose={() => setEditing(null)} />}

      <Invitations />
    </div>
  );
}

/**
 * The tick boxes under a level. For a full user every box starts ticked and
 * unticking one keeps that part away from them ("no QuickBooks"). For an
 * office user the day-to-day boxes are ticked and the owner's-side boxes are
 * off until Adam ticks them.
 */
function AreaPicker({ level, allowed, onChange, disabled }: {
  level: AccessLevel;
  allowed: Set<Area>;
  onChange: (next: Set<Area>) => void;
  disabled?: boolean;
}) {
  if (level === 'mobile') return null;
  return (
    <div className="grid grid-cols-2 gap-2">
      {AREAS.map(area => (
        <label key={area} className="flex items-center gap-2 text-sm">
          <Checkbox
            checked={allowed.has(area)}
            disabled={disabled}
            onCheckedChange={(checked) => {
              const next = new Set(allowed);
              if (checked) next.add(area); else next.delete(area);
              onChange(next);
            }}
            data-testid={`area-${area}`}
          />
          {AREA_LABELS[area]}
        </label>
      ))}
    </div>
  );
}

function EditPersonDialog({ user, onClose }: { user: AppUser; onClose: () => void }) {
  const { data: me } = useMe();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const updateUser = useUpdateUser();
  const deleteUser = useDeleteUser();

  const isOwner = user.roleSource === 'owner';
  const isSelf = me?.id === user.id;

  const [displayName, setDisplayName] = useState(user.displayName || '');
  const [phone, setPhone] = useState(user.phone || '');
  const [baseAddress, setBaseAddress] = useState(user.baseAddress || '');
  const [birthday, setBirthday] = useState(user.birthday || '');
  const [hireDate, setHireDate] = useState(user.hireDate || '');
  const [level, setLevel] = useState<AccessLevel>(user.accessLevel);
  const [allowed, setAllowed] = useState<Set<Area>>(() => allowedAreas(user.accessLevel, user.permissions ?? []));
  const [active, setActive] = useState(user.active);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['/api/users'] });
    queryClient.invalidateQueries({ queryKey: ['me'] });
  };

  const changeLevel = (next: AccessLevel) => {
    setLevel(next);
    // Start from what the level gives by itself; the boxes are then the extras.
    setAllowed(allowedAreas(next, []));
  };

  const handleSave = () => {
    setError(null);
    updateUser.mutate({
      id: user.id,
      data: {
        displayName: displayName.trim() || null,
        phone: phone.trim() || null,
        baseAddress: baseAddress.trim() || null,
        birthday: birthday || null,
        hireDate: hireDate || null,
        accessLevel: level,
        permissions: permissionsFor(level, allowed),
        active,
      },
    }, {
      onSuccess: () => {
        invalidate();
        toast({ title: 'Saved', description: `${displayName.trim() || user.name} updated.` });
        onClose();
      },
      onError: (e: any) => {
        // e.g. taking the Team page away from yourself, or fencing the owner
        setError(e?.data?.error || e?.message || 'Could not save changes');
      },
    });
  };

  const handleDelete = () => {
    setError(null);
    deleteUser.mutate({ id: user.id }, {
      onSuccess: () => {
        invalidate();
        toast({ title: 'Removed', description: `${user.name} is off the team.` });
        onClose();
      },
      onError: (e: any) => setError(e?.data?.error || e?.message || 'Could not delete'),
    });
  };

  const hasJobs = (user.jobCount ?? 0) > 0;
  // Notes, tickets and reviewed suggestions hold a person in place just like
  // jobs do, so Delete is only offered when there is nothing at all on record.
  const hasHistory = (user.historyCount ?? user.jobCount ?? 0) > 0;
  const explain = LEVELS.find(l => l.value === level)?.explain;

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{user.name}</DialogTitle>
          <DialogDescription>
            Signs in as {user.fullName || user.name}{user.email ? ` (${user.email})` : ''}.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4">
          <div className="grid gap-1.5">
            <Label htmlFor="displayName">Name shown on the board</Label>
            <Input id="displayName" value={displayName} onChange={e => setDisplayName(e.target.value)} placeholder={user.fullName || user.name} data-testid="edit-display-name" />
            <p className="text-xs text-muted-foreground">Short and friendly — this is what the dispatch board and job cards show instead of an email.</p>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="phone">Phone</Label>
              <Input id="phone" value={phone} onChange={e => setPhone(e.target.value)} placeholder="208-555-0100" />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="baseAddress">Starts the day from</Label>
              <Input id="baseAddress" value={baseAddress} onChange={e => setBaseAddress(e.target.value)} placeholder="Address (for routing)" />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="birthday">Birthday</Label>
              <Input id="birthday" type="date" value={birthday} onChange={e => setBirthday(e.target.value)} data-testid="edit-birthday" />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="hireDate">Hire date</Label>
              <Input id="hireDate" type="date" value={hireDate} onChange={e => setHireDate(e.target.value)} data-testid="edit-hire-date" />
            </div>
          </div>

          <div className="grid gap-2 rounded-md border p-3">
            <Label>Access</Label>
            {isOwner ? (
              <p className="text-sm text-muted-foreground">The owner always has every part of the app. That cannot be changed here.</p>
            ) : (
              <>
                <div className="flex flex-wrap gap-2">
                  {LEVELS.map(l => (
                    <Button
                      key={l.value}
                      type="button"
                      size="sm"
                      variant={level === l.value ? 'default' : 'outline'}
                      onClick={() => changeLevel(l.value)}
                      data-testid={`level-${l.value}`}
                    >
                      {l.label}
                    </Button>
                  ))}
                </div>
                <p className="text-xs text-muted-foreground">{explain}</p>
                <AreaPicker level={level} allowed={allowed} onChange={setAllowed} />
                {isSelf && level !== 'mobile' && !allowed.has('team') && (
                  <p className="text-xs text-destructive">You cannot take the Team page away from yourself.</p>
                )}
              </>
            )}
          </div>

          {/* GPS-SMS track: the masked texting number customers see for this person. Saves on its own, not with the form. */}
          <SmsNumberField user={user} />

          <div className="flex items-center justify-between rounded-md border p-3">
            <div>
              <Label htmlFor="active">Active</Label>
              <p className="text-xs text-muted-foreground">
                Turned off means they cannot sign in and drop out of every list. Their jobs and notes stay.
              </p>
            </div>
            <Switch id="active" checked={active} onCheckedChange={setActive} disabled={isOwner || isSelf} data-testid="edit-active" />
          </div>

          {!isOwner && !isSelf && (
            <div className="rounded-md border border-dashed p-3 text-sm">
              {hasJobs ? (
                <p className="text-muted-foreground">
                  {user.name} has {user.jobCount} job{user.jobCount === 1 ? '' : 's'} on record, so they cannot be deleted — turn them off instead and the history stays.
                </p>
              ) : hasHistory ? (
                <p className="text-muted-foreground">
                  {user.name} has notes or tickets on record, so they cannot be deleted — turn them off instead and the history stays.
                </p>
              ) : confirmDelete ? (
                <div className="flex items-center justify-between gap-2">
                  <span>Delete {user.name} for good?</span>
                  <div className="flex gap-1">
                    <Button size="sm" variant="destructive" onClick={handleDelete} disabled={deleteUser.isPending} data-testid="confirm-delete">Yes, delete</Button>
                    <Button size="sm" variant="ghost" onClick={() => setConfirmDelete(false)}>No</Button>
                  </div>
                </div>
              ) : (
                <Button size="sm" variant="ghost" className="text-destructive" onClick={() => setConfirmDelete(true)} data-testid="delete-user">
                  <Trash2 className="w-4 h-4 mr-1" /> Delete this person (nothing on record)
                </Button>
              )}
            </div>
          )}

          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button onClick={handleSave} disabled={updateUser.isPending} data-testid="save-user">Save</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Invitations() {
  const { data: invitations, isLoading } = useListInvitations();
  const [email, setEmail] = useState('');
  const [level, setLevel] = useState<AccessLevel>('mobile');
  const [allowed, setAllowed] = useState<Set<Area>>(() => allowedAreas('mobile', []));
  const [error, setError] = useState<string | null>(null);

  const queryClient = useQueryClient();
  const createInvitation = useCreateInvitation();
  const revokeInvitation = useRevokeInvitation();
  const resendInvitation = useResendInvitation();

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['/api/invitations'] });

  const changeLevel = (next: AccessLevel) => {
    setLevel(next);
    setAllowed(allowedAreas(next, []));
  };

  const handleInvite = () => {
    if (!email.trim()) return;
    setError(null);
    createInvitation.mutate({
      data: { email: email.trim(), accessLevel: level, permissions: permissionsFor(level, allowed) },
    }, {
      onSuccess: () => {
        setEmail('');
        changeLevel('mobile');
        invalidate();
      },
      onError: (e: any) => {
        // e.g. that address already belongs to a signed-up account
        setError(e?.data?.error || e?.message || 'Could not send invite');
      },
    });
  };

  const handleResend = (id: number) => {
    setError(null);
    resendInvitation.mutate({ id }, {
      onSuccess: (inv: any) => {
        invalidate();
        // The send is reported rather than assumed: the whole point of this
        // control is that pressing Invite used to claim something it had not done.
        if (inv && !inv.emailedAt) setError(inv.emailError || 'The invitation email did not send.');
      },
      onError: (e: any) => setError(e?.data?.error || e?.message || 'Could not resend the invitation'),
    });
  };

  const handleRevoke = (id: number) => {
    revokeInvitation.mutate({ id }, { onSuccess: invalidate });
  };

  return (
    <div className="bg-card border rounded-lg shadow-sm flex flex-col overflow-hidden">
      <div className="p-4 border-b space-y-3">
        <div>
          <h2 className="font-semibold">Invite Someone</h2>
          {/* The invite itself grants nothing — it only takes effect once that
              person signs up and Clerk verifies they actually control the
              address. Otherwise the owner assumes sending the invite was the
              access grant. */}
          <p className="text-sm text-muted-foreground mt-0.5">
            Sending an invite does not grant access by itself. The access you pick here applies once that
            person signs up using this exact email and verifies it.
          </p>
        </div>
        <div className="flex flex-wrap gap-2 items-center">
          <Input
            className="h-8 max-w-xs"
            type="email"
            placeholder="email@example.com"
            value={email}
            onChange={e => setEmail(e.target.value)}
            data-testid="invite-email"
          />
          <select
            className="h-8 rounded-md border border-input bg-background px-2 text-sm"
            value={level}
            onChange={e => changeLevel(e.target.value as AccessLevel)}
            data-testid="invite-level"
          >
            {LEVELS.map(l => <option key={l.value} value={l.value}>{l.label}</option>)}
          </select>
          <Button size="sm" onClick={handleInvite} disabled={createInvitation.isPending || !email.trim()} data-testid="invite-send">
            <Mail className="w-4 h-4 mr-1" /> Invite
          </Button>
          {error && <p className="text-xs text-destructive whitespace-normal">{error}</p>}
        </div>
        {level !== 'mobile' && (
          <div className="max-w-md">
            <p className="text-xs text-muted-foreground mb-2">{LEVELS.find(l => l.value === level)?.explain}</p>
            <AreaPicker level={level} allowed={allowed} onChange={setAllowed} />
          </div>
        )}
      </div>

      <div className="overflow-auto max-h-[40vh]">
        <Table>
          <TableHeader className="bg-muted/50">
            <TableRow>
              <TableHead>Email</TableHead>
              <TableHead>Access</TableHead>
              <TableHead>Invited By</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="w-16"></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow><TableCell colSpan={5} className="text-center py-4">Loading...</TableCell></TableRow>
            ) : !invitations?.length ? (
              <TableRow><TableCell colSpan={5} className="text-center py-4">No invitations yet.</TableCell></TableRow>
            ) : (
              invitations.map(inv => (
                <TableRow key={inv.id} className="hover:bg-muted/50">
                  <TableCell className="font-medium">{inv.email}</TableCell>
                  <TableCell>
                    <span className={`px-2 py-0.5 rounded text-xs font-bold uppercase ${inv.accessLevel === 'mobile' ? 'bg-accent text-accent-foreground' : 'bg-primary text-primary-foreground'}`}>
                      {levelLabel(inv.accessLevel)}
                    </span>
                    {inv.permissions?.length ? (
                      <div className="text-xs text-muted-foreground mt-1">
                        {inv.permissions.map(p => p.startsWith('!') ? `no ${AREA_LABELS[p.slice(1) as Area] ?? p.slice(1)}` : `plus ${AREA_LABELS[p as Area] ?? p}`).join(', ')}
                      </div>
                    ) : null}
                  </TableCell>
                  <TableCell className="text-muted-foreground">{inv.invitedByName || '-'}</TableCell>
                  <TableCell>
                    {inv.acceptedAt ? (
                      <span className="text-xs text-muted-foreground">Accepted {new Date(inv.acceptedAt).toLocaleDateString()}</span>
                    ) : (
                      <div className="space-y-0.5">
                        <div className="text-xs text-amber-600 dark:text-amber-500">Pending — not yet signed up</div>
                        {/*
                          Whether they were actually told. "I sent an invite to a
                          contractor, but they didn't receive it" — and they had
                          not, because inviting only ever wrote a row. Saying
                          "Pending" alone cannot distinguish someone ignoring an
                          email from someone who never got one.
                        */}
                        {inv.emailedAt ? (
                          <div className="text-xs text-muted-foreground">
                            Emailed {new Date(inv.emailedAt).toLocaleDateString()}
                          </div>
                        ) : inv.emailError ? (
                          <div className="text-xs text-destructive">Email failed — {inv.emailError}</div>
                        ) : (
                          <div className="text-xs text-destructive">Never emailed</div>
                        )}
                      </div>
                    )}
                  </TableCell>
                  <TableCell className="text-right">
                    {!inv.acceptedAt && (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-8 text-xs"
                        onClick={() => handleResend(inv.id)}
                        disabled={resendInvitation.isPending}
                        data-testid={`resend-invitation-${inv.id}`}
                      >
                        {inv.emailedAt ? 'Resend' : 'Send'}
                      </Button>
                    )}
                    {!inv.acceptedAt && (
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-8 w-8 text-muted-foreground hover:text-destructive"
                        onClick={() => handleRevoke(inv.id)}
                        disabled={revokeInvitation.isPending}
                      >
                        <X className="w-4 h-4" />
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
