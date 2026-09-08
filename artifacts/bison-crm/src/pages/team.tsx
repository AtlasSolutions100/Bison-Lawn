import { useState } from 'react';
import {
  useListUsers, useUpdateUser,
  useListInvitations, useCreateInvitation, useRevokeInvitation, useResendInvitation,
} from '@workspace/api-client-react';
import { useQueryClient } from '@tanstack/react-query';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Check, Edit2, Mail, X } from 'lucide-react';

export default function Team() {
  const { data: users, isLoading } = useListUsers();

  return (
    <div className="p-8 max-w-6xl mx-auto space-y-6 flex flex-col h-[calc(100vh-2rem)]">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Team Directory</h1>
        {/* "words like contractor, employee, crew lead all the same" — so the
            app settles on one and says so once, rather than making him work out
            whether three labels mean three different things. */}
        <p className="text-muted-foreground mt-1">
          Manage admins and contractors. <span className="text-foreground">Contractor</span> covers
          anyone who works jobs — employee, crew lead or subcontractor. There is one word for all of them here.
        </p>
      </div>

      <div className="bg-card border rounded-lg shadow-sm overflow-auto max-h-[45vh]">
        <Table>
          <TableHeader className="bg-muted/50">
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Email</TableHead>
              <TableHead>Role</TableHead>
              <TableHead>Phone</TableHead>
              <TableHead>Base Location</TableHead>
              <TableHead className="w-24"></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow><TableCell colSpan={6} className="text-center py-4">Loading...</TableCell></TableRow>
            ) : !users?.length ? (
              <TableRow><TableCell colSpan={6} className="text-center py-4">No team members found.</TableCell></TableRow>
            ) : (
              users.map(u => <UserRow key={u.id} user={u} />)
            )}
          </TableBody>
        </Table>
      </div>

      <Invitations />
    </div>
  );
}

function Invitations() {
  const { data: invitations, isLoading } = useListInvitations();
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<'admin' | 'contractor'>('contractor');
  const [error, setError] = useState<string | null>(null);

  const queryClient = useQueryClient();
  const createInvitation = useCreateInvitation();
  const revokeInvitation = useRevokeInvitation();
  const resendInvitation = useResendInvitation();

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['/api/invitations'] });

  const handleInvite = () => {
    if (!email.trim()) return;
    setError(null);
    createInvitation.mutate({ data: { email: email.trim(), role } }, {
      onSuccess: () => {
        setEmail('');
        setRole('contractor');
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
    <div className="bg-card border rounded-lg shadow-sm flex-1 flex flex-col overflow-hidden">
      <div className="p-4 border-b space-y-3">
        <div>
          <h2 className="font-semibold">Invite Someone</h2>
          {/* The invite itself grants nothing — it only takes effect once that
              person signs up and Clerk verifies they actually control the
              address. Otherwise the owner assumes sending the invite was the
              access grant. */}
          <p className="text-sm text-muted-foreground mt-0.5">
            Sending an invite does not grant access by itself. The role only applies once that
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
          />
          <select
            className="h-8 rounded-md border border-input bg-background px-2 text-sm"
            value={role}
            onChange={e => setRole(e.target.value as 'admin' | 'contractor')}
          >
            <option value="contractor">Contractor</option>
            <option value="admin">Admin</option>
          </select>
          <Button size="sm" onClick={handleInvite} disabled={createInvitation.isPending || !email.trim()}>
            <Mail className="w-4 h-4 mr-1" /> Invite
          </Button>
          {error && <p className="text-xs text-destructive whitespace-normal">{error}</p>}
        </div>
      </div>

      <div className="flex-1 overflow-auto">
        <Table>
          <TableHeader className="bg-muted/50">
            <TableRow>
              <TableHead>Email</TableHead>
              <TableHead>Role</TableHead>
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
                    <span className={`px-2 py-0.5 rounded text-xs font-bold uppercase ${inv.role === 'admin' ? 'bg-primary text-primary-foreground' : 'bg-accent text-accent-foreground'}`}>
                      {inv.role}
                    </span>
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

function UserRow({ user }: { user: any }) {
  const [isEditing, setIsEditing] = useState(false);
  const [role, setRole] = useState(user.role);
  const [phone, setPhone] = useState(user.phone || '');
  const [baseAddress, setBaseAddress] = useState(user.baseAddress || '');
  
  const [error, setError] = useState<string | null>(null);

  const updateUser = useUpdateUser();
  const queryClient = useQueryClient();

  const handleSave = () => {
    setError(null);
    updateUser.mutate({
      id: user.id,
      data: { role, phone, baseAddress }
    }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: ['/api/users'] });
        setIsEditing(false);
      },
      onError: (e: any) => {
        // e.g. an admin trying to remove their own access, or demoting the owner
        setError(e?.data?.error || e?.message || 'Could not save changes');
      }
    });
  };

  const handleCancel = () => {
    setRole(user.role);
    setPhone(user.phone || '');
    setBaseAddress(user.baseAddress || '');
    setError(null);
    setIsEditing(false);
  };

  if (isEditing) {
    return (
      <TableRow className="bg-muted/30">
        <TableCell className="font-medium">{user.name}</TableCell>
        <TableCell>{user.email}</TableCell>
        <TableCell>
          <select className="h-8 w-full rounded-md border border-input bg-background px-2 text-sm" value={role} onChange={e => setRole(e.target.value)}>
            <option value="admin">Admin</option>
            <option value="contractor">Contractor</option>
          </select>
        </TableCell>
        <TableCell>
          <Input className="h-8" value={phone} onChange={e => setPhone(e.target.value)} placeholder="Phone" />
        </TableCell>
        <TableCell>
          <Input className="h-8" value={baseAddress} onChange={e => setBaseAddress(e.target.value)} placeholder="Address (for routing)" />
        </TableCell>
        <TableCell className="space-x-1 whitespace-nowrap">
          <Button size="icon" variant="ghost" className="h-8 w-8 text-primary" onClick={handleSave} disabled={updateUser.isPending}><Check className="w-4 h-4" /></Button>
          <Button size="icon" variant="ghost" className="h-8 w-8 text-muted-foreground" onClick={handleCancel}><X className="w-4 h-4" /></Button>
          {error && <p className="text-xs text-destructive mt-1 whitespace-normal">{error}</p>}
        </TableCell>
      </TableRow>
    );
  }

  return (
    <TableRow className="hover:bg-muted/50">
      <TableCell className="font-semibold">{user.name}</TableCell>
      <TableCell className="text-muted-foreground">{user.email}</TableCell>
      <TableCell>
        <span className={`px-2 py-0.5 rounded text-xs font-bold uppercase ${user.role === 'admin' ? 'bg-primary text-primary-foreground' : 'bg-accent text-accent-foreground'}`}>
          {user.role}
        </span>
      </TableCell>
      <TableCell className="text-muted-foreground">{user.phone || '-'}</TableCell>
      <TableCell className="text-muted-foreground">{user.baseAddress || '-'}</TableCell>
      <TableCell className="text-right">
        <Button size="icon" variant="ghost" className="h-8 w-8 text-muted-foreground hover:text-primary" onClick={() => setIsEditing(true)}>
          <Edit2 className="w-4 h-4" />
        </Button>
      </TableCell>
    </TableRow>
  );
}
