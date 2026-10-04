import { useGetEmailSender } from '@workspace/api-client-react';
import { AtSign, CheckCircle2 } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';

/**
 * Settings › Who your emails come from.
 *
 * His note was "Document comes from Koby, needs from Bison Lawn Care". Letters
 * and bills now go out with Bison Lawn Care on the From line and his own
 * address on Reply-To, which is the address a customer writes to when they
 * press Reply. The one thing we cannot do from inside the app is put his
 * address itself on the From line — Google only allows an address the sending
 * mailbox owns — so this card says that out loud instead of letting him find
 * out from a customer.
 */
export function SenderIdentityCard() {
  const { data, isLoading, isError } = useGetEmailSender();

  return (
    <Card data-testid="sender-identity-card">
      <CardHeader>
        <div className="flex items-center gap-3">
          <div className="rounded-full bg-primary/10 p-2"><AtSign className="h-5 w-5 text-primary" /></div>
          <div>
            <CardTitle className="flex items-center gap-2">
              Who your emails come from
              {data?.ownDomain && <Badge className="bg-green-600 text-white">Your own address</Badge>}
            </CardTitle>
            <CardDescription>
              What a customer sees in their inbox when this app emails them a letter, a bill or an estimate.
            </CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        {isLoading ? (
          <Skeleton className="h-28 w-full" />
        ) : isError || !data ? (
          <p className="text-muted-foreground">
            The sending address could not be read just now. Nothing is wrong with your email — reload the page.
          </p>
        ) : (
          <>
            <div className="rounded-lg border bg-muted/40 p-4">
              <p className="text-xs uppercase tracking-wide text-muted-foreground">Customers see</p>
              <p className="mt-1 font-semibold break-words" data-testid="sender-customers-see">{data.customersSee}</p>
              <p className="mt-2 text-muted-foreground">
                {data.replyTo ? (
                  <>When they press Reply it goes to <strong className="text-foreground">{data.replyTo}</strong>.</>
                ) : (
                  <>
                    You have no company email filled in above, so a reply goes back to whichever mailbox sent it.
                    Fill in Email and save.
                  </>
                )}
              </p>
            </div>

            {data.ownDomain ? (
              <Alert>
                <CheckCircle2 className="h-4 w-4" />
                <AlertTitle>This is fully your own address</AlertTitle>
                <AlertDescription>
                  Your name and your address are both on every email that goes out.
                </AlertDescription>
              </Alert>
            ) : (
              <div className="space-y-2">
                <p className="font-semibold">Why not your own address on the From line</p>
                {/* Only true while we really do write a From line. When Google
                    refused the address, or there is no company email to try,
                    nothing of ours goes on that line and the card must say so
                    instead of promising him his name is on it. */}
                <p className="text-muted-foreground">
                  {data.fromAddress ? (
                    <>
                      Everything this app sends goes through one connected Google mailbox. Google will only put an
                      address on the From line that the mailbox owns or has confirmed, so your company name goes
                      there and your address goes on Reply-To. Your name is what a customer reads, and your address
                      is where their answer lands.
                    </>
                  ) : (
                    <>
                      Everything this app sends goes through one connected Google mailbox, and right now we cannot
                      put anything of yours on the From line — so Google writes that mailbox's own name there, not
                      your company name. Your address is still on Reply-To, so an answer comes to you.
                    </>
                  )}
                </p>
                {data.whatWouldBeNeeded && (
                  <>
                    <p className="font-semibold">What it would take to change that</p>
                    <p className="text-muted-foreground">{data.whatWouldBeNeeded}</p>
                  </>
                )}
                {data.note && <p className="text-muted-foreground">{data.note}</p>}
              </div>
            )}

            {data.aliases.length > 0 && (
              <p className="text-xs text-muted-foreground">
                Addresses that mailbox can send as: {data.aliases.join(', ')}.
              </p>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

export default SenderIdentityCard;
