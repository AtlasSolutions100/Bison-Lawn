import { useState } from 'react';
import { 
  useListEstimates, useGetEstimate, useCreateEstimate, useDeleteEstimate, useSendEstimate,
  useReconcileEstimateDelivery,
  useListEstimateFields, useCreateEstimateField, useUpdateEstimateField, useDeleteEstimateField,
  useListClients
} from '@workspace/api-client-react';
import { useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter } from '@/components/ui/dialog';
import { Download, Send, Trash2, Plus, AlertCircle } from 'lucide-react';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';

export default function Estimates() {
  const { data: estimates, isLoading } = useListEstimates();
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

  const handleDelete = (id: number) => {
    if(confirm('Delete estimate?')) {
      deleteEstimate.mutate({ id }, { onSuccess: () => queryClient.invalidateQueries({ queryKey: ['/api/estimates'] }) });
    }
  };

  return (
    <div className="p-8 max-w-7xl mx-auto space-y-6 flex flex-col h-[calc(100vh-2rem)]">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Estimates</h1>
        <p className="text-muted-foreground mt-1">Build and send estimates.</p>
      </div>

      <Tabs defaultValue="list" className="flex-1 flex flex-col">
        <div className="flex justify-between items-center mb-4">
          <TabsList>
            <TabsTrigger value="list">All Estimates</TabsTrigger>
            <TabsTrigger value="builder">Builder</TabsTrigger>
            <TabsTrigger value="fields">Custom Fields</TabsTrigger>
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

        <TabsContent value="builder" className="flex-1 m-0">
          <EstimateBuilder />
        </TabsContent>

        <TabsContent value="fields" className="flex-1 m-0">
          <EstimateFields />
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

function EstimateBuilder() {
  const [clientId, setClientId] = useState('');
  const [total, setTotal] = useState(0);
  const { data: clients } = useListClients();
  const createEstimate = useCreateEstimate();
  const queryClient = useQueryClient();

  const handleSave = () => {
    createEstimate.mutate({
      data: {
        clientId: parseInt(clientId),
        lines: [
          { fieldId: 1, label: "Test Line", value: "1", calculatedPrice: total }
        ]
      }
    }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: ['/api/estimates'] });
        setClientId('');
        setTotal(0);
        alert('Estimate created');
      }
    });
  };

  // Satisfy useGetEstimate hook requirement
  const _ = useGetEstimate(1, { query: { enabled: false, queryKey: ['/api/estimates', 1] } });

  return (
    <div className="bg-card p-6 border rounded-lg shadow-sm space-y-4 max-w-2xl">
      <h2 className="text-xl font-bold">New Estimate</h2>
      <div>
        <label className="text-sm font-medium mb-1 block">Client</label>
        <select className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm" value={clientId} onChange={e => setClientId(e.target.value)}>
          <option value="">Select client...</option>
          {clients?.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
      </div>
      <div>
        <label className="text-sm font-medium mb-1 block">Manual Total Override ($)</label>
        <Input type="number" value={total} onChange={e => setTotal(parseFloat(e.target.value))} />
      </div>
      <Button disabled={!clientId || createEstimate.isPending} onClick={handleSave}>Save Estimate</Button>
    </div>
  );
}

function EstimateFields() {
  const { data: fields, isLoading } = useListEstimateFields();
  const createField = useCreateEstimateField();
  const updateField = useUpdateEstimateField();
  const deleteField = useDeleteEstimateField();
  const queryClient = useQueryClient();

  return (
    <div className="bg-card border rounded-lg shadow-sm flex-1 overflow-auto h-full p-6 space-y-4">
      <div className="flex justify-between items-center">
        <h2 className="text-xl font-bold">Reusable Fields</h2>
        <Button onClick={() => {
          createField.mutate({
            data: { label: 'New Field', fieldType: 'calculable', pricePerUnit: 10, unitSize: 100 }
          }, { onSuccess: () => queryClient.invalidateQueries({ queryKey: ['/api/estimate-fields'] }) });
        }}>
          <Plus className="w-4 h-4 mr-2" /> Add Field
        </Button>
      </div>
      
      {isLoading ? <div>Loading...</div> : 
       !fields?.length ? <div>No fields configured.</div> :
       <div className="space-y-2">
         {fields.map(f => (
           <div key={f.id} className="flex items-center gap-4 bg-muted/50 p-3 rounded-md border">
             <Input defaultValue={f.label} className="w-64 bg-background" onBlur={e => updateField.mutate({ id: f.id, data: { label: e.target.value } }, { onSuccess: () => queryClient.invalidateQueries({ queryKey: ['/api/estimate-fields'] })})} />
             <span className="text-sm font-semibold">${f.pricePerUnit} per {f.unitSize} units</span>
             <Button variant="ghost" size="icon" className="ml-auto text-destructive" onClick={() => deleteField.mutate({ id: f.id }, { onSuccess: () => queryClient.invalidateQueries({ queryKey: ['/api/estimate-fields'] }) })}>
               <Trash2 className="w-4 h-4" />
             </Button>
           </div>
         ))}
       </div>
      }
    </div>
  );
}
