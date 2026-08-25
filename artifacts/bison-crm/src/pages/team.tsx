import { useState } from 'react';
import { useListUsers, useUpdateUser } from '@workspace/api-client-react';
import { useQueryClient } from '@tanstack/react-query';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Check, Edit2, X } from 'lucide-react';

export default function Team() {
  const { data: users, isLoading } = useListUsers();

  return (
    <div className="p-8 max-w-6xl mx-auto space-y-6 flex flex-col h-[calc(100vh-2rem)]">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Team Directory</h1>
        <p className="text-muted-foreground mt-1">Manage admins and contractors.</p>
      </div>

      <div className="bg-card border rounded-lg shadow-sm flex-1 overflow-auto">
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
