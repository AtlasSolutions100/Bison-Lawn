import { useEffect, useMemo, useState } from 'react';
import {
  useGetCompanyProfile,
  useUpdateCompanyProfile,
  useListMergeTokens,
  useListDocumentTemplates,
  useCreateDocumentTemplate,
  useUpdateDocumentTemplate,
  useDeleteDocumentTemplate,
  usePreviewDocumentTemplate,
  useListClients,
  useListServices,
  getListDocumentTemplatesQueryKey,
  getGetCompanyProfileQueryKey,
  type DocumentTemplate,
  type DocumentTemplateKind,
  type DocumentTemplateCategory,
  type DocumentPreview,
} from '@workspace/api-client-react';
import { useQueryClient } from '@tanstack/react-query';
import { AlertCircle, Building2, Eye, FileText, Plus, Save, Trash2 } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import { useToast } from '@/hooks/use-toast';
import { SmsStatusCard } from '@/components/sms-status-card';
import ProductPresets from '@/components/products/product-presets';

const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : 'Something went wrong. Please try again.';

export default function Settings() {
  return (
    <div className="p-6 md:p-8 max-w-7xl mx-auto space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Settings</h1>
        <p className="text-muted-foreground mt-1">
          Your business details and the letters and proposals you send customers.
        </p>
      </div>

      <CompanyDetails />
      <SmsStatusCard />
      <ProductPresets />
      <DocumentTemplates />
    </div>
  );
}

// ---------------------------------------------------------------- company ----

type ProfileField = {
  key: 'name' | 'addressLine1' | 'addressLine2' | 'city' | 'state' | 'postalCode' | 'phone' | 'email' | 'website' | 'signatureLine';
  label: string;
  /** The merge token this field fills, so it is obvious what editing it changes. */
  token: string;
  placeholder?: string;
  /** Blank is a real problem in a customer's letter, not just an empty field. */
  warnIfBlank?: string;
  wide?: boolean;
};

const PROFILE_FIELDS: ProfileField[] = [
  { key: 'name', label: 'Business name', token: '[companyname]', placeholder: 'Bison Lawn Care LLC', warnIfBlank: 'Letters will greet customers from a company with no name.', wide: true },
  { key: 'addressLine1', label: 'Address line 1', token: '[companyaddress]', placeholder: '123 Depot St' },
  { key: 'addressLine2', label: 'Address line 2', token: '[companyaddress]', placeholder: 'Suite 4' },
  { key: 'city', label: 'City', token: '[companycity]', placeholder: 'Bozeman' },
  { key: 'state', label: 'State', token: '[companystate]', placeholder: 'MT' },
  { key: 'postalCode', label: 'ZIP', token: '[companyzip]', placeholder: '59715' },
  { key: 'phone', label: 'Phone', token: '[companyphonenumber]', placeholder: '(406) 555-0142', warnIfBlank: 'Your aeration notice says "contact us at [companyphonenumber]." With this blank it goes out reading "contact us at ."' },
  { key: 'email', label: 'Email', token: '[companyemail]', placeholder: 'office@bisonlawncare.com', warnIfBlank: 'The footer of every letter shows your email. It will be missing.' },
  { key: 'website', label: 'Website', token: '[companywebsite]', placeholder: 'bisonlawncare.com' },
  { key: 'signatureLine', label: 'Sign-off', token: '[signatureline]', placeholder: 'Your Friendly Bison,', warnIfBlank: 'Every letter signs off with this line. Blank leaves your name floating under the last paragraph.', wide: true },
];

type ProfileDraft = Record<ProfileField['key'], string>;

const EMPTY_PROFILE: ProfileDraft = {
  name: '', addressLine1: '', addressLine2: '', city: '', state: '', postalCode: '',
  phone: '', email: '', website: '', signatureLine: '',
};

function CompanyDetails() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const profileQuery = useGetCompanyProfile();
  const updateProfile = useUpdateCompanyProfile();

  const [draft, setDraft] = useState<ProfileDraft>(EMPTY_PROFILE);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (!profileQuery.data || loaded) return;
    const profile = profileQuery.data;
    setDraft({
      name: profile.name ?? '',
      addressLine1: profile.addressLine1 ?? '',
      addressLine2: profile.addressLine2 ?? '',
      city: profile.city ?? '',
      state: profile.state ?? '',
      postalCode: profile.postalCode ?? '',
      phone: profile.phone ?? '',
      email: profile.email ?? '',
      website: profile.website ?? '',
      signatureLine: profile.signatureLine ?? '',
    });
    setLoaded(true);
  }, [profileQuery.data, loaded]);

  // Address line 2 and website are genuinely optional — his letters drop the
  // line cleanly when they are empty — so they are not nagged about here.
  const blanks = PROFILE_FIELDS.filter((field) => field.warnIfBlank && !draft[field.key].trim());

  const save = () => {
    updateProfile.mutate(
      {
        data: {
          name: draft.name.trim(),
          // Empty means "we don't have one", not an empty string in the letter.
          addressLine1: draft.addressLine1.trim() || null,
          addressLine2: draft.addressLine2.trim() || null,
          city: draft.city.trim() || null,
          state: draft.state.trim() || null,
          postalCode: draft.postalCode.trim() || null,
          phone: draft.phone.trim() || null,
          email: draft.email.trim() || null,
          website: draft.website.trim() || null,
          signatureLine: draft.signatureLine,
        },
      },
      {
        onSuccess: async () => {
          await queryClient.invalidateQueries({ queryKey: getGetCompanyProfileQueryKey() });
          toast({ title: 'Company details saved', description: 'New letters and estimates use these straight away.' });
        },
        onError: (error) =>
          toast({ title: 'Details were not saved', description: errorMessage(error), variant: 'destructive' }),
      },
    );
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-3">
          <div className="rounded-full bg-primary/10 p-2"><Building2 className="h-5 w-5 text-primary" /></div>
          <div>
            <CardTitle>Company details</CardTitle>
            <CardDescription>
              These fill the <code className="rounded bg-muted px-1">[companyname]</code>,{' '}
              <code className="rounded bg-muted px-1">[companyaddress]</code> and{' '}
              <code className="rounded bg-muted px-1">[companyphonenumber]</code> tokens in every letter,
              proposal and estimate email you send. Whatever you type here is what the customer reads.
            </CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {profileQuery.isLoading ? (
          <Skeleton className="h-64 w-full" />
        ) : profileQuery.isError ? (
          <Alert variant="destructive">
            <AlertCircle className="h-4 w-4" />
            <AlertTitle>Company details could not be loaded</AlertTitle>
            <AlertDescription>{errorMessage(profileQuery.error)}</AlertDescription>
          </Alert>
        ) : (
          <>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {PROFILE_FIELDS.map((field) => (
                <div key={field.key} className={field.wide ? 'sm:col-span-2 lg:col-span-3' : undefined}>
                  <Label htmlFor={`company-${field.key}`} className="flex flex-wrap items-center gap-2">
                    {field.label}
                    <code className="rounded bg-muted px-1 text-xs font-normal text-muted-foreground">{field.token}</code>
                  </Label>
                  <Input
                    id={`company-${field.key}`}
                    className="mt-1"
                    placeholder={field.placeholder}
                    value={draft[field.key]}
                    onChange={(event) => setDraft((current) => ({ ...current, [field.key]: event.target.value }))}
                  />
                </div>
              ))}
            </div>

            {/* A blank field here is silent: nothing errors, the letter simply
                goes out with a hole in it. This is the only place it can be
                caught before a customer reads it. */}
            {blanks.length > 0 && (
              <Alert variant="destructive">
                <AlertCircle className="h-4 w-4" />
                <AlertTitle>
                  {blanks.length === 1 ? 'One detail is blank' : `${blanks.length} details are blank`} and customers will see the gap
                </AlertTitle>
                <AlertDescription>
                  <ul className="mt-1 list-disc space-y-1 pl-4">
                    {blanks.map((field) => (
                      <li key={field.key}><strong>{field.label}</strong> — {field.warnIfBlank}</li>
                    ))}
                  </ul>
                </AlertDescription>
              </Alert>
            )}

            <Button onClick={save} disabled={updateProfile.isPending || !draft.name.trim()}>
              <Save className="mr-2 h-4 w-4" />
              {updateProfile.isPending ? 'Saving…' : 'Save company details'}
            </Button>
          </>
        )}
      </CardContent>
    </Card>
  );
}

// -------------------------------------------------------------- templates ----

const KIND_LABELS: Record<DocumentTemplateKind, string> = {
  notice: 'Notice letter',
  estimate_cover: 'Estimate cover letter',
  contract: 'Contract / terms',
};

const KIND_HELP: Record<DocumentTemplateKind, string> = {
  notice: 'A standalone letter about upcoming work, such as the aeration notice.',
  estimate_cover: 'The letter wrapped around a quote. It can use [Bison_Full_Service] and [quotetotal].',
  contract: 'Terms appended below a quote.',
};

/** His three folders, the way his old system sorted documents. */
const CATEGORY_LABELS: Record<DocumentTemplateCategory, string> = {
  client: 'Client',
  marketing: 'Marketing',
  estimate: 'Estimate',
};

const CATEGORY_HELP: Record<DocumentTemplateCategory, string> = {
  client: 'Letters to one customer about their account: bills, past due, blow-out day, welcome.',
  marketing: 'Letters that go to everybody: spring letter, turn up your sprinklers, fall notice.',
  estimate: 'Anything that wraps or chases a quote: proposals, the contract, follow-ups.',
};

type TemplateDraft = {
  name: string;
  kind: DocumentTemplateKind;
  category: DocumentTemplateCategory;
  /** '' means "not tied to a service"; the API stores that as null. */
  serviceId: string;
  subject: string;
  body: string;
};

const EMPTY_TEMPLATE: TemplateDraft = { name: '', kind: 'notice', category: 'client', serviceId: '', subject: '', body: '' };

const draftFrom = (template: DocumentTemplate): TemplateDraft => ({
  name: template.name,
  kind: template.kind,
  category: template.category,
  serviceId: template.serviceId != null ? String(template.serviceId) : '',
  subject: template.subject ?? '',
  body: template.body,
});

/** Same shape the renderer matches, so what is flagged here is what it will refuse to fill. */
const TOKEN_PATTERN = /\[[A-Za-z0-9_:]+\]/g;

function DocumentTemplates() {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const templatesQuery = useListDocumentTemplates();
  const tokensQuery = useListMergeTokens();
  const servicesQuery = useListServices();
  const clientsQuery = useListClients();

  const createTemplate = useCreateDocumentTemplate();
  const updateTemplate = useUpdateDocumentTemplate();
  const deleteTemplate = useDeleteDocumentTemplate();
  const previewTemplate = usePreviewDocumentTemplate();

  const [selectedId, setSelectedId] = useState<number | 'new' | null>(null);
  const [draft, setDraft] = useState<TemplateDraft>(EMPTY_TEMPLATE);
  const [preview, setPreview] = useState<DocumentPreview | null>(null);
  const [previewClientId, setPreviewClientId] = useState<string>('');
  const [previewMode, setPreviewMode] = useState<'email' | 'text'>('email');
  const [categoryTab, setCategoryTab] = useState<'all' | DocumentTemplateCategory>('all');

  const templates = templatesQuery.data;
  const visibleTemplates = useMemo(
    () => (templates ?? []).filter((t) => categoryTab === 'all' || t.category === categoryTab),
    [templates, categoryTab],
  );
  const selected = typeof selectedId === 'number' ? templates?.find((t) => t.id === selectedId) : undefined;

  const choose = (template: DocumentTemplate) => {
    setSelectedId(template.id);
    setDraft(draftFrom(template));
    setPreview(null);
  };

  const startNew = () => {
    setSelectedId('new');
    // A new letter lands in the folder he is looking at.
    setDraft({ ...EMPTY_TEMPLATE, category: categoryTab === 'all' ? 'client' : categoryTab });
    setPreview(null);
  };

  useEffect(() => {
    if (selectedId !== null || !templates?.length) return;
    choose(templates[0]);
    // choose() is stable enough for this one-shot initial selection.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [templates, selectedId]);

  /**
   * Unknown tokens are worked out against the list the server serves, never a
   * list written down here. The renderer is the only thing that knows what it
   * can fill; a copy kept in this file would drift and start telling him a
   * token is fine when the customer will read it as literal text.
   */
  const knownTokens = useMemo(
    () => new Set((tokensQuery.data ?? []).map((token) => token.toLowerCase())),
    [tokensQuery.data],
  );

  const draftUnknownTokens = useMemo(() => {
    // Before the token list has loaded there is nothing to judge against, and
    // flagging every token as unknown would be worse than saying nothing.
    if (!knownTokens.size) return [];
    const found = new Set<string>();
    for (const match of `${draft.subject}\n${draft.body}`.matchAll(TOKEN_PATTERN)) {
      if (!knownTokens.has(match[0].toLowerCase())) found.add(match[0]);
    }
    return [...found];
  }, [draft.subject, draft.body, knownTokens]);

  const dirty = selected ? JSON.stringify(draft) !== JSON.stringify(draftFrom(selected)) : selectedId === 'new';
  const canSave = Boolean(draft.name.trim() && draft.body.trim());

  const invalidateTemplates = () =>
    queryClient.invalidateQueries({ queryKey: getListDocumentTemplatesQueryKey() });

  const save = () => {
    const serviceId = draft.serviceId ? Number(draft.serviceId) : null;
    if (selectedId === 'new') {
      createTemplate.mutate(
        { data: { name: draft.name.trim(), kind: draft.kind, category: draft.category, serviceId, subject: draft.subject.trim() || null, body: draft.body } },
        {
          onSuccess: async (created) => {
            await invalidateTemplates();
            choose(created);
            toast({ title: 'Template created', description: `Saved as "${created.name}".` });
          },
          onError: (error) =>
            toast({ title: 'Template was not created', description: errorMessage(error), variant: 'destructive' }),
        },
      );
      return;
    }
    if (typeof selectedId !== 'number') return;
    updateTemplate.mutate(
      { id: selectedId, data: { name: draft.name.trim(), kind: draft.kind, category: draft.category, serviceId, subject: draft.subject.trim() || null, body: draft.body } },
      {
        onSuccess: async (saved) => {
          await invalidateTemplates();
          setDraft(draftFrom(saved));
          setPreview(null);
          toast({ title: 'Template saved' });
        },
        onError: (error) =>
          toast({ title: 'Template was not saved', description: errorMessage(error), variant: 'destructive' }),
      },
    );
  };

  const remove = (template: DocumentTemplate) => {
    if (!confirm(`Delete "${template.name}"? Anything scheduled to use it will fall back to the plain letter.`)) return;
    deleteTemplate.mutate(
      { id: template.id },
      {
        onSuccess: async () => {
          await invalidateTemplates();
          setSelectedId(null);
          setPreview(null);
          toast({ title: `"${template.name}" deleted` });
        },
        onError: (error) =>
          toast({ title: 'Template was not deleted', description: errorMessage(error), variant: 'destructive' }),
      },
    );
  };

  const runPreview = () => {
    if (typeof selectedId !== 'number') return;
    previewTemplate.mutate(
      { id: selectedId, data: { clientId: previewClientId ? Number(previewClientId) : null } },
      {
        onSuccess: (result) => setPreview(result),
        onError: (error) =>
          toast({ title: 'Preview could not be rendered', description: errorMessage(error), variant: 'destructive' }),
      },
    );
  };

  const copyToken = async (token: string) => {
    try {
      await navigator.clipboard.writeText(token);
      toast({ title: `${token} copied` });
    } catch {
      toast({ title: 'Could not copy', description: `Type it in as ${token}`, variant: 'destructive' });
    }
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="rounded-full bg-primary/10 p-2"><FileText className="h-5 w-5 text-primary" /></div>
            <div>
              <CardTitle>Document templates</CardTitle>
              <CardDescription>Your letters and proposals, with your own [tokens] filled in per customer.</CardDescription>
            </div>
          </div>
          <Button variant="outline" onClick={startNew}>
            <Plus className="mr-2 h-4 w-4" />New template
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {templatesQuery.isLoading ? (
          <Skeleton className="h-96 w-full" />
        ) : templatesQuery.isError ? (
          <Alert variant="destructive">
            <AlertCircle className="h-4 w-4" />
            <AlertTitle>Templates could not be loaded</AlertTitle>
            <AlertDescription>{errorMessage(templatesQuery.error)}</AlertDescription>
          </Alert>
        ) : (
          <div className="grid gap-6 lg:grid-cols-[18rem_minmax(0,1fr)]">
            <div className="space-y-2">
              {/* His folders. "All" first so nothing is ever hidden from him. */}
              <div className="flex flex-wrap gap-1 rounded-lg border bg-muted/40 p-1">
                {(['all', 'client', 'marketing', 'estimate'] as const).map((tab) => {
                  const count = tab === 'all' ? templates?.length ?? 0 : (templates ?? []).filter((t) => t.category === tab).length;
                  return (
                    <button
                      key={tab}
                      type="button"
                      onClick={() => setCategoryTab(tab)}
                      className={`flex-1 rounded-md px-2 py-1 text-xs font-semibold ${
                        categoryTab === tab ? 'bg-background shadow-sm' : 'text-muted-foreground hover:text-foreground'
                      }`}
                    >
                      {tab === 'all' ? 'All' : CATEGORY_LABELS[tab]} <span className="font-normal text-muted-foreground">{count}</span>
                    </button>
                  );
                })}
              </div>
              {!templates?.length && (
                <p className="rounded-lg border p-6 text-center text-sm text-muted-foreground">
                  No templates yet. Start one with “New template”.
                </p>
              )}
              {templates?.length && !visibleTemplates.length ? (
                <p className="rounded-lg border p-6 text-center text-sm text-muted-foreground">
                  Nothing in this folder yet. Pick a letter and set its folder to {categoryTab === 'all' ? '' : CATEGORY_LABELS[categoryTab]}.
                </p>
              ) : null}
              {visibleTemplates.map((template) => (
                <button
                  key={template.id}
                  type="button"
                  onClick={() => choose(template)}
                  className={`w-full rounded-lg border p-3 text-left transition ${
                    selectedId === template.id ? 'border-primary bg-primary/5' : 'hover:bg-muted/50'
                  }`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <span className="font-semibold">{template.name}</span>
                    {template.unknownTokens?.length ? (
                      <Badge variant="destructive" className="shrink-0">
                        {template.unknownTokens.length} unknown
                      </Badge>
                    ) : null}
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                    <span>{CATEGORY_LABELS[template.category] ?? template.category}</span>
                    <span>· {KIND_LABELS[template.kind]}</span>
                    {template.serviceName && <span>· {template.serviceName}</span>}
                    {template.isSeeded && <span>· built in</span>}
                  </div>
                </button>
              ))}
              {selectedId === 'new' && (
                <div className="rounded-lg border border-primary bg-primary/5 p-3 text-sm font-semibold">New template</div>
              )}
            </div>

            <div className="space-y-5">
              {selectedId === null ? (
                <p className="rounded-lg border p-6 text-center text-muted-foreground">
                  Choose a template on the left to edit it.
                </p>
              ) : (
                <>
                  <div className="grid gap-4 sm:grid-cols-2">
                    <div>
                      <Label htmlFor="template-name">Name</Label>
                      <Input
                        id="template-name"
                        className="mt-1"
                        placeholder="Aeration notice"
                        value={draft.name}
                        onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))}
                      />
                      <p className="mt-1 text-xs text-muted-foreground">Only you see this — customers never do.</p>
                    </div>
                    <div>
                      <Label htmlFor="template-kind">Kind</Label>
                      <select
                        id="template-kind"
                        className="mt-1 flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                        value={draft.kind}
                        onChange={(event) =>
                          setDraft((current) => ({ ...current, kind: event.target.value as DocumentTemplateKind }))
                        }
                      >
                        {(Object.keys(KIND_LABELS) as DocumentTemplateKind[]).map((kind) => (
                          <option key={kind} value={kind}>{KIND_LABELS[kind]}</option>
                        ))}
                      </select>
                      <p className="mt-1 text-xs text-muted-foreground">{KIND_HELP[draft.kind]}</p>
                    </div>
                    <div>
                      <Label htmlFor="template-category">Folder</Label>
                      <select
                        id="template-category"
                        className="mt-1 flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                        value={draft.category}
                        onChange={(event) =>
                          setDraft((current) => ({ ...current, category: event.target.value as DocumentTemplateCategory }))
                        }
                      >
                        {(Object.keys(CATEGORY_LABELS) as DocumentTemplateCategory[]).map((category) => (
                          <option key={category} value={category}>{CATEGORY_LABELS[category]}</option>
                        ))}
                      </select>
                      <p className="mt-1 text-xs text-muted-foreground">{CATEGORY_HELP[draft.category]}</p>
                    </div>
                    <div>
                      <Label htmlFor="template-service">Service</Label>
                      <select
                        id="template-service"
                        className="mt-1 flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                        value={draft.serviceId}
                        onChange={(event) => setDraft((current) => ({ ...current, serviceId: event.target.value }))}
                      >
                        <option value="">No particular service</option>
                        {servicesQuery.data?.map((service) => (
                          <option key={service.id} value={service.id}>{service.name}</option>
                        ))}
                      </select>
                      <p className="mt-1 text-xs text-muted-foreground">
                        Sending for this service picks this letter up automatically.
                      </p>
                    </div>
                    <div>
                      <Label htmlFor="template-subject">Email subject</Label>
                      <Input
                        id="template-subject"
                        className="mt-1"
                        placeholder="Your upcoming aeration | [companyname]"
                        value={draft.subject}
                        onChange={(event) => setDraft((current) => ({ ...current, subject: event.target.value }))}
                      />
                      <p className="mt-1 text-xs text-muted-foreground">Leave blank for documents that are not emailed on their own.</p>
                    </div>
                  </div>

                  <div className="grid gap-5 lg:grid-cols-[minmax(0,2fr)_minmax(15rem,1fr)]">
                    <div>
                      <Label htmlFor="template-body">Letter</Label>
                      <Textarea
                        id="template-body"
                        className="mt-1 min-h-[28rem] font-mono text-sm"
                        value={draft.body}
                        onChange={(event) => setDraft((current) => ({ ...current, body: event.target.value }))}
                      />
                      <p className="mt-1 text-xs text-muted-foreground">Wrap a phrase in **two stars** to make it bold, *one star* for italics, and start a line with - for a bullet.</p>
                    </div>
                    <div className="rounded-lg border bg-muted/40 p-4">
                      <h3 className="font-semibold">Merge tokens</h3>
                      <p className="mt-1 text-sm text-muted-foreground">
                        Click one to copy it, then paste it into the letter. Each is filled in per customer when the letter is sent.
                      </p>
                      {tokensQuery.isLoading ? (
                        <Skeleton className="mt-3 h-64 w-full" />
                      ) : (
                        <div className="mt-3 max-h-80 space-y-1 overflow-y-auto pr-1">
                          {tokensQuery.data?.map((token) => (
                            <button
                              key={token}
                              type="button"
                              onClick={() => copyToken(token)}
                              className="block w-full rounded bg-background px-2 py-1 text-left font-mono text-xs hover:bg-accent"
                            >
                              {token}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>

                  {/* An unknown token is not a formatting nit: it survives the
                      render untouched and the customer reads the brackets. */}
                  {draftUnknownTokens.length > 0 && (
                    <Alert variant="destructive">
                      <AlertCircle className="h-4 w-4" />
                      <AlertTitle>
                        {draftUnknownTokens.length === 1
                          ? 'This token will be printed as-is in the customer’s letter'
                          : `These ${draftUnknownTokens.length} tokens will be printed as-is in the customer’s letter`}
                      </AlertTitle>
                      <AlertDescription>
                        <div className="mt-1 flex flex-wrap gap-2">
                          {draftUnknownTokens.map((token) => (
                            <code key={token} className="rounded bg-background/80 px-2 py-0.5 font-mono text-xs">{token}</code>
                          ))}
                        </div>
                        <p className="mt-2">
                          Nothing fills these, so the customer sees the square brackets exactly as typed. Fix the spelling
                          against the token list, or replace them with real wording.
                        </p>
                      </AlertDescription>
                    </Alert>
                  )}

                  <div className="flex flex-wrap items-center gap-3">
                    <Button
                      onClick={save}
                      disabled={!canSave || !dirty || createTemplate.isPending || updateTemplate.isPending}
                    >
                      <Save className="mr-2 h-4 w-4" />
                      {createTemplate.isPending || updateTemplate.isPending
                        ? 'Saving…'
                        : selectedId === 'new' ? 'Create template' : 'Save template'}
                    </Button>
                    {selected && (
                      <Button
                        variant="ghost"
                        className="text-muted-foreground hover:text-destructive"
                        onClick={() => remove(selected)}
                        disabled={deleteTemplate.isPending}
                      >
                        <Trash2 className="mr-2 h-4 w-4" />Delete
                      </Button>
                    )}
                    {dirty && selectedId !== 'new' && (
                      <span className="text-sm text-muted-foreground">Unsaved changes</span>
                    )}
                  </div>

                  <div className="border-t pt-5">
                    <h3 className="font-semibold">Preview against a real customer</h3>
                    <p className="mt-1 text-sm text-muted-foreground">
                      See your own words with somebody’s real name, address and phone number filled in — exactly what
                      lands in their inbox.
                    </p>
                    <div className="mt-3 flex flex-wrap items-end gap-3">
                      <div className="min-w-64 flex-1">
                        <Label htmlFor="preview-client">Customer</Label>
                        <select
                          id="preview-client"
                          className="mt-1 flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                          value={previewClientId}
                          onChange={(event) => setPreviewClientId(event.target.value)}
                        >
                          <option value="">Any customer</option>
                          {clientsQuery.data?.map((client) => (
                            <option key={client.id} value={client.id}>{client.name}</option>
                          ))}
                        </select>
                      </div>
                      <Button
                        variant="secondary"
                        onClick={runPreview}
                        disabled={selectedId === 'new' || dirty || previewTemplate.isPending}
                      >
                        <Eye className="mr-2 h-4 w-4" />
                        {previewTemplate.isPending ? 'Rendering…' : 'Show preview'}
                      </Button>
                    </div>

                    {/* The preview renders the saved row, so previewing a dirty
                        draft would show him words he is no longer looking at. */}
                    {dirty ? (
                      <Alert className="mt-3">
                        <AlertCircle className="h-4 w-4" />
                        <AlertTitle>Save before previewing</AlertTitle>
                        <AlertDescription>The preview always renders the last saved version of this template.</AlertDescription>
                      </Alert>
                    ) : preview ? (
                      <div className="mt-3 rounded-lg border bg-background p-5">
                        <div className="mb-3 flex flex-wrap items-center justify-between gap-2 border-b pb-3">
                          <div>
                            <span className="text-xs uppercase text-muted-foreground">Subject</span>
                            <p className="font-semibold">{preview.subject || <span className="text-muted-foreground">(no subject)</span>}</p>
                          </div>
                          <div className="flex items-center gap-2">
                            {preview.clientName && <Badge variant="secondary">As {preview.clientName} sees it</Badge>}
                            {preview.html && (
                              <div className="flex rounded-md border p-0.5 text-xs">
                                <button type="button" onClick={() => setPreviewMode('email')} className={`rounded px-2 py-0.5 ${previewMode === 'email' ? 'bg-muted font-semibold' : 'text-muted-foreground'}`}>Email</button>
                                <button type="button" onClick={() => setPreviewMode('text')} className={`rounded px-2 py-0.5 ${previewMode === 'text' ? 'bg-muted font-semibold' : 'text-muted-foreground'}`}>Plain text</button>
                              </div>
                            )}
                          </div>
                        </div>
                        {preview.unknownTokens.length > 0 && (
                          <Alert variant="destructive" className="mb-3">
                            <AlertCircle className="h-4 w-4" />
                            <AlertTitle>Unfilled tokens are visible below</AlertTitle>
                            <AlertDescription>
                              {preview.unknownTokens.join(', ')} appear in this letter exactly as written.
                            </AlertDescription>
                          </Alert>
                        )}
                        {preview.html && previewMode === 'email' ? (
                          // Sandboxed: the shell is ours, but the body is whatever he typed.
                          <iframe
                            title="Email preview"
                            sandbox=""
                            srcDoc={preview.html}
                            className="h-[42rem] w-full rounded-md border bg-[#f7f5f1]"
                          />
                        ) : (
                          <pre className="whitespace-pre-wrap font-sans text-sm leading-6">{preview.body}</pre>
                        )}
                      </div>
                    ) : null}
                  </div>
                </>
              )}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
