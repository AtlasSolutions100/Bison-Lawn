import { useState } from 'react';
import {
  useGetSmsStatus,
  useListUsers,
  useSetUserSmsNumber,
  getGetSmsStatusQueryKey,
  type AppUser,
} from '@workspace/api-client-react';
import { useQueryClient } from '@tanstack/react-query';
import { MessageSquare } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useToast } from '@/hooks/use-toast';

/**
 * Settings › Texting. Says whether texting is on, what it costs to turn on,
 * and exactly which server keys do it — so the answer to "why can't I text
 * from the CRM" is on the screen, not in a support email.
 */

function fmt(n: string | null | undefined) {
  const d = (n ?? '').replace(/\D/g, '').slice(-10);
  return d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : (n ?? '');
}

export function SmsStatusCard() {
  const { data: status, isLoading } = useGetSmsStatus();
  const { data: users } = useListUsers();
  const withNumbers = (users ?? []).filter((u) => u.smsProxyNumber);

  return (
    <Card data-testid="sms-status-card">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <MessageSquare className="w-5 h-5" /> Texting
          {isLoading ? null : status?.configured
            ? <Badge className="bg-green-600 text-white">On</Badge>
            : <Badge variant="secondary">Off</Badge>}
        </CardTitle>
        <CardDescription>
          Text customers from the CRM, and give each contractor a company number so customers never see their real one.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        {status?.configured ? (
          <div className="space-y-1">
            <p>Texting is <strong>on</strong> through {status.provider}.</p>
            <p>Office number: <strong>{status.officeNumber ? fmt(status.officeNumber) : 'not set (SMS_OFFICE_NUMBER)'}</strong>.</p>
            <p>
              {withNumbers.length === 0
                ? 'Nobody has a masked number yet — give them one on the Team page.'
                : `Masked numbers: ${withNumbers.map((u) => `${u.name} ${fmt(u.smsProxyNumber)}`).join(', ')}.`}
            </p>
            <p className="text-muted-foreground">
              Every number's messaging webhook must point at <code className="text-xs">{status.webhookUrl}</code>.
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            <p>
              Texting is <strong>off</strong>. The Text button on a customer still works: it opens your own phone's
              Messages app, and the customer sees your real number.
            </p>
            <p className="font-semibold">What turning it on takes</p>
            {/* The honest version. He was told "free texting" by his old system; the number-masking half is never free. */}
            <ul className="list-disc pl-5 space-y-1 text-muted-foreground">
              <li>A texting provider account (built for Twilio). Work Optional can set it up.</li>
              <li>About <strong>$1 a month per number</strong> — one for the office and one per contractor — plus a fraction of a cent per text (about $0.008).</li>
              <li>A one-time <strong>business registration (A2P 10DLC)</strong> before US carriers will deliver company texts: a small fee, a few dollars a month, it takes days to a few weeks to approve, and it needs the company EIN and address.</li>
              <li>For a crew this size the bill is roughly $5–15 a month.</li>
            </ul>
            <p className="font-semibold">The server keys that switch it on</p>
            <div className="rounded-md border bg-muted/30 p-2 font-mono text-xs space-y-0.5" data-testid="sms-env-keys">
              {(status?.envKeys ?? []).map((k) => (
                <div key={k.key} className="flex flex-wrap gap-x-2">
                  <span className="font-semibold">{k.key}</span>
                  <span className={k.set ? 'text-green-700' : 'text-muted-foreground'}>{k.set ? 'set' : 'not set'}</span>
                  <span className="text-muted-foreground font-sans">— {k.note}</span>
                </div>
              ))}
            </div>
            <p className="text-muted-foreground">
              Then point every number's messaging webhook at <code className="text-xs">{status?.webhookUrl ?? '…/api/public/sms/inbound'}</code> and
              give each contractor their number on the Team page. Every text in or out is kept on the customer's page either way.
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * The "Texting number" box in a person's Team dialog. Saved whether or not
 * texting is on, so the numbers are ready the day the provider is switched on.
 */
export function SmsNumberField({ user }: { user: AppUser }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data: status } = useGetSmsStatus();
  const setNumber = useSetUserSmsNumber();
  const [value, setValue] = useState(user.smsProxyNumber ?? '');
  const [error, setError] = useState<string | null>(null);

  const dirty = (value.trim() || null) !== (user.smsProxyNumber ?? null);

  const save = () => {
    setError(null);
    setNumber.mutate(
      { id: user.id, data: { smsProxyNumber: value.trim() || null } },
      {
        onSuccess: (updated) => {
          queryClient.invalidateQueries({ queryKey: ['/api/users'] });
          queryClient.invalidateQueries({ queryKey: getGetSmsStatusQueryKey() });
          setValue(updated.smsProxyNumber ?? '');
          toast({
            title: updated.smsProxyNumber ? 'Texting number saved' : 'Texting number removed',
            description: updated.smsProxyNumber ? `${user.name} texts customers from ${fmt(updated.smsProxyNumber)}.` : undefined,
          });
        },
        onError: (e: any) => setError(e?.data?.error || e?.message || 'Could not save the number'),
      },
    );
  };

  return (
    <div className="grid gap-1.5 rounded-md border p-3">
      <Label htmlFor="smsProxyNumber">Texting number (what customers see)</Label>
      <div className="flex gap-2">
        <Input
          id="smsProxyNumber"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="208-555-0142"
          data-testid="edit-sms-number"
        />
        <Button type="button" size="sm" variant="outline" onClick={save} disabled={!dirty || setNumber.isPending} data-testid="save-sms-number">
          Save
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        {status?.configured
          ? `Customers text this number and it comes through to ${user.name}'s own phone${user.phone ? ` (${user.phone})` : ' — add their phone above first'}. Their reply goes back out from this number.`
          : 'Texting is off right now (Settings › Texting), so this is saved for when it is turned on. One company number per person, bought from the texting provider.'}
      </p>
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}
