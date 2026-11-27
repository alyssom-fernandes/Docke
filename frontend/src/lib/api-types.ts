/* eslint-disable */
// Gerado por backend/scripts/gerar_tipos_ts.py a partir do OpenAPI da API.
// Não edite à mão: em backend/, rode `python scripts/gerar_tipos_ts.py`.

export interface AccessGrantCreate {
  permission_level: string;
  folder_id?: string | null;
  expires_on?: string | null;
}

export interface AccessGrantUpdate {
  permission_level: string;
}

export interface AccessRequestCreate {
  folder_id: string;
  message?: string | null;
}

export interface AccessRequestDecision {
  aprovar: boolean;
  permission_level?: string;
  expires_on?: string | null;
}

export interface Acompanhar {
  protocolo: string;
  codigo: string;
}

/** Documento ou pasta ancorada pela pessoa (GET /favorites). */
export interface Ancorado {
  id: string;
  user_id: string;
  document_id: string | null;
  folder_id: string | null;
  created_at: string;
  item_type: "document" | "folder";
  item_name: string;
  document_folder_id: string | null;
  location: string | null;
}

export interface ApplyDefault {
  modo?: string;
  aplicar?: boolean;
}

export interface AssignmentCreate {
  company_id: string;
  folder_id?: string | null;
  policy_id: string;
  match_tipo_fiscal?: string | null;
  match_field_id?: string | null;
  match_field_value?: string | null;
}

export interface AvatarSet {
  avatar_key?: string | null;
}

export interface AvatarUploadRequest {
  content_type: string;
  size_bytes: number;
}

export interface Aviso {
  id: string;
  type: string;
  resource_type: string | null;
  resource_id: string | null;
  company_id: string | null;
  message: string | null;
  read_at: string | null;
  created_at: string;
  snoozed_until: string | null;
  archived_at: string | null;
  folder_id: string | null;
  in_trash: boolean;
}

export interface BatchStart {
  company_id: string;
  folder_id?: string | null;
  folder_name?: string | null;
  total: number;
  data_original?: boolean;
}

export interface BatchUpdate {
  ok: number;
  falhas?: Falha[];
  concluido?: boolean;
}

export interface BulkCopyRequest {
  document_ids: string[];
  target_folder_id: string;
}

export interface BulkDeleteRequest {
  document_ids: string[];
}

export interface BulkDownloadRequest {
  document_ids: string[];
}

export interface BulkFieldValues {
  document_ids: string[];
  values: DocumentFieldValueSet[];
}

export interface BulkMoveRequest {
  document_ids: string[];
  target_folder_id: string;
}

export interface BulkRestoreRequest {
  document_ids: string[];
}

export interface CaixaBody {
  folder_id?: string | null;
}

export interface CanalBody {
  enabled: boolean;
}

export interface ChangePasswordRequest {
  current_password: string;
  new_password: string;
}

export interface Chaves {
  p256dh: string;
  auth: string;
}

export interface CheckoutRequest {
  note?: string | null;
}

export interface ColaboradorBody {
  name: string;
  registration?: string | null;
  role_title?: string | null;
  admission_date: string;
  termination_date?: string | null;
  periodic_months?: number;
}

export interface ColaboradorMuda {
  name?: string | null;
  registration?: string | null;
  role_title?: string | null;
  admission_date?: string | null;
  termination_date?: string | null;
  limpar_desligamento?: boolean;
  periodic_months?: number | null;
}

export interface ComentarioMuda {
  resolved: boolean;
}

export interface ComentarioNovo {
  body: string;
  page?: number | null;
  x?: number | null;
  y?: number | null;
}

export interface CompanyCreate {
  name: string;
}

export interface CompanyUpdate {
  name?: string | null;
  cnpj?: string | null;
  is_active?: boolean | null;
  logo_key?: string | null;
}

/** Concessão de acesso (GET /companies/{id}/members): uma linha por pasta. */
export interface ConcessaoDaEmpresa {
  access_id: string;
  user_id: string;
  role: string;
  full_name: string | null;
  username: string | null;
  created_at: string;
  folder_id: string | null;
  folder_name: string | null;
}

export interface ConcessaoDireta {
  access_id: string;
  role: string;
  folder_id: string | null;
  folder_name: string | null;
  created_at: string | null;
  expires_at: string | null;
}

export interface ConcessaoPorGrupo {
  group_id: string;
  group_name: string;
  role: string;
  folder_id: string | null;
  folder_name: string | null;
}

export interface ConfigImport {
  pacote: Record<string, unknown>;
  incluir_pastas?: boolean;
  dry_run?: boolean;
}

export interface Cota {
  quota_gb?: number | null;
}

export interface CustomFieldCopy {
  source_company_id: string;
  target_company_id: string;
}

export interface CustomFieldCopySelected {
  source_company_id: string;
  target_company_id: string;
  field_ids?: string[] | null;
  include_tree?: boolean;
}

export interface CustomFieldCreate {
  company_id: string;
  label: string;
  type: string;
  format_config?: Record<string, unknown>;
  condition_field_id?: string | null;
  condition_value?: string | null;
}

export interface CustomFieldUpdate {
  label?: string | null;
  format_config?: Record<string, unknown> | null;
  condition_field_id?: string | null;
  condition_value?: string | null;
  clear_condition?: boolean;
}

export interface Decision {
  decision: "manter" | "retirar";
  note?: string | null;
}

export interface DependencyCreate {
  template_id: string;
  depends_on_template_id: string;
}

export interface DocTemplateFlag {
  is_template: boolean;
}

export interface DocumentFieldValueSet {
  custom_field_id: string;
  value: string;
}

export interface DocumentLink {
  document_id: string;
  valid_until?: string | null;
}

export interface DocumentPatch {
  name?: string | null;
  sector?: string | null;
  competencia?: string | null;
  tipo_fiscal?: string | null;
}

/** Documento que comprova a competência. */
export interface DocumentoDaObrigacao {
  id: string;
  obligation_instance_id: string;
  document_id: string;
  linked_by: string | null;
  linked_at: string;
  valid_until: string | null;
  document_name: string;
  folder_id: string;
  folder_name: string | null;
  document_created_at: string;
  linked_by_name: string | null;
}

/** Detalhe do documento (GET /documents/{id}); o texto inteiro vem por /text. */
export interface DocumentoDetalhe {
  id: string;
  name: string;
  folder_id: string;
  company_id: string;
  mime_type: string;
  file_type: string;
  size_bytes: number;
  content_hash: string | null;
  sector: string | null;
  competencia: string | null;
  tipo_fiscal: string | null;
  ocr_status: string;
  ocr_completed_at: string | null;
  uploaded_by: string | null;
  created_at: string;
  updated_at: string;
  deleted_original_folder_id: string | null;
  thumb_url: string | null;
  uploaded_by_name: string | null;
  ocr_excerpt: string;
  ocr_text_length: number;
  nfe: Record<string, unknown> | null;
  checkout: Reserva | null;
  nfe_evento: Record<string, unknown> | null;
}

export interface DocumentoNaLixeira {
  id: string;
  name: string;
  folder_id: string;
  company_id: string;
  file_type: string;
  size_bytes: number;
  deleted_at: string;
  trash_expires_at: string | null;
  deleted_original_folder_id: string | null;
  original_folder_name: string | null;
  original_folder_deleted: boolean;
  original_path: string | null;
  deleted_by_name: string | null;
  bloqueio: string | null;
  item_type: "document";
}

/** Linha da lista de documentos da pasta (GET /documents). */
export interface DocumentoNaPasta {
  id: string;
  name: string;
  folder_id: string;
  company_id: string;
  mime_type: string;
  file_type: string;
  size_bytes: number;
  storage_path: string;
  content_hash: string | null;
  sector: string | null;
  competencia: string | null;
  tipo_fiscal: string | null;
  ocr_status: string;
  uploaded_by: string | null;
  created_at: string;
  updated_at: string;
  is_template: boolean;
  uploaded_by_name: string | null;
  favorited: boolean;
  active_share_count: number;
  thumb_url?: string | null;
}

/** Documento recente da empresa (GET /documents/recent). */
export interface DocumentoRecente {
  id: string;
  name: string;
  folder_id: string;
  company_id: string;
  mime_type: string;
  file_type: string;
  size_bytes: number;
  ocr_status: string;
  created_at: string;
  folder_name: string | null;
  opened_at?: string | null;
}

export interface DoubleApproval {
  enabled: boolean;
}

/** Dados da empresa (GET /companies/{id}). */
export interface Empresa {
  id: string;
  name: string;
  created_at: string;
}

/** Empresa que a pessoa acessa (GET /companies). */
export interface EmpresaDaPessoa {
  id: string;
  name: string;
  created_at: string;
  permission_level: string;
  features: Record<string, boolean>;
}

export interface ErroDoNavegador {
  message: string;
  stack?: string | null;
  path?: string | null;
}

/** Evento da trilha. */
export interface EventoAtividade {
  id: string;
  user_id: string | null;
  company_id: string | null;
  action: string;
  item_type: string | null;
  item_id: string | null;
  item_name_snapshot: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
  user_name: string | null;
  user_username: string | null;
  current_folder_id: string | null;
}

export interface ExameBody {
  kind: "admissional" | "periodico" | "retorno" | "mudanca_risco" | "demissional";
  exam_date: string;
  result?: "apto" | "apto_restricao" | "inapto";
  document_id?: string | null;
  notes?: string | null;
}

export interface Facetas {
  sector: ValorFaceta[];
  file_type: ValorFaceta[];
}

export interface Falha {
  nome: string;
  motivo: string;
}

export interface FavoriteCreate {
  document_id?: string | null;
  folder_id?: string | null;
}

export interface FeaturesUpdate {
  features: Record<string, boolean>;
  motivo?: string | null;
}

export interface FieldTypeChange {
  new_type: string;
  aplicar?: boolean;
}

export interface FieldValuesQuery {
  document_ids: string[];
}

export interface FiscalProfileUpdate {
  regime_tributario?: string | null;
  faixa_funcionarios?: string | null;
  uf?: string | null;
  tipo_juridico?: string | null;
  cnae_principal?: string | null;
}

export interface FolderCopyDocuments {
  target_company_id: string;
  pairs: FolderPair[];
}

export interface FolderCopyStructure {
  target_company_id: string;
  target_parent_id?: string | null;
  include_metadata?: boolean;
  include_documents?: boolean;
  include_privacy?: boolean;
  include_access?: boolean;
  include_retention?: boolean;
  dry_run?: boolean;
}

export interface FolderCreate {
  name: string;
  parent_id?: string | null;
  company_id: string;
}

export interface FolderFieldUpsert {
  company_id: string;
  folder_id?: string | null;
  custom_field_id: string;
  mode?: string;
  required?: boolean;
  display_order?: number;
  column_width?: number | null;
  default_value?: string | null;
}

export interface FolderMove {
  parent_id?: string | null;
}

export interface FolderPair {
  source_folder_id: string;
  target_folder_id: string;
}

export interface FolderRename {
  name: string;
}

export interface FolderRulesCopy {
  company_id: string;
  source_folder_id: string;
  target_folder_id: string;
}

export interface ForgotPasswordRequest {
  email: string;
  redirect_to?: string | null;
}

export interface GroupAccessGrantCreate {
  permission_level: string;
  folder_id?: string | null;
}

export interface GroupCreate {
  name: string;
}

export interface GroupMemberAdd {
  user_id: string;
}

export interface HistoricoObrigacao {
  id: string;
  action: string;
  metadata: Record<string, unknown> | null;
  created_at: string;
  user_name: string | null;
}

export interface HoldCreate {
  company_id: string;
  resource_type: string;
  resource_id: string;
  reason: string;
  process_number?: string | null;
  review_date?: string | null;
}

export interface HoldRelease {
  reason: string;
}

export interface IncidenteMudanca {
  status?: "aberto" | "contido" | "encerrado" | null;
  responsavel_id?: string | null;
  categorias?: ("identificacao" | "contato" | "documentos" | "financeiro" | "saude" | "trabalhista" | "credenciais" | "criancas" | "outros")[] | null;
  titulares_afetados?: number | null;
  risco_relevante?: boolean | null;
  avaliacao_risco?: string | null;
  medidas?: string | null;
  comunicado_anpd_em?: string | null;
  protocolo_anpd?: string | null;
  comunicado_titulares_em?: string | null;
  nota?: string | null;
}

export interface IncidenteNovo {
  titulo: string;
  descricao?: string | null;
  descoberto_em?: string | null;
  ocorrido_em?: string | null;
  categorias?: ("identificacao" | "contato" | "documentos" | "financeiro" | "saude" | "trabalhista" | "credenciais" | "criancas" | "outros")[];
  titulares_afetados?: number | null;
  medidas?: string | null;
}

export interface Inscricao {
  endpoint: string;
  keys: Chaves;
}

export interface InstanceCreate {
  template_id: string;
  period: string;
  due_date: string;
  owner_id?: string | null;
  notes?: string | null;
}

export interface InstanceStatusUpdate {
  status: string;
  dispensa_motivo?: string | null;
}

export interface InstanceUpdate {
  owner_id?: string | null;
  notes?: string | null;
  due_date?: string | null;
}

export interface JuntarRequest {
  destino_id: string;
}

/** Link na lista de compartilhados (GET /shares). */
export interface LinkCompartilhado {
  id: string;
  resource_type: string;
  resource_id: string;
  company_id: string;
  expires_at: string | null;
  revoked_at: string | null;
  view_count: number | null;
  last_accessed_at: string | null;
  created_at: string;
  has_password: boolean;
  max_views: number | null;
  allow_download: boolean | null;
  pin_to_version_id: string | null;
  resource_name: string | null;
  document_folder_id: string | null;
  created_by: string | null;
  created_by_name: string | null;
  expired_at: string | null;
}

/** Caixa de avisos (GET /notifications). */
export interface ListaAvisos {
  results: Aviso[];
  unread_count: number;
}

/** Itens na lixeira da empresa (GET /trash). */
export interface Lixeira {
  documents: DocumentoNaLixeira[];
  folders: PastaNaLixeira[];
  total: number;
}

export interface LoginRequest {
  email: string;
  password: string;
}

export interface LoginResponse {
  access_token: string;
  refresh_token?: string | null;
  token_type?: string;
  expires_in: number;
  user: Record<string, unknown>;
}

export interface LogoUploadRequest {
  content_type: string;
}

export interface MemberCreate {
  email: string;
  password: string;
  username: string;
  full_name: string;
  permission_level?: string;
  folder_id?: string | null;
  expires_on?: string | null;
}

export interface MfaPolicy {
  policy: string;
  motivo?: string | null;
}

export interface MfaRecoverRequest {
  code: string;
}

export interface MfaVerifyRequest {
  code: string;
  factor_id?: string | null;
}

export interface MultipartAbortRequest {
  upload_id: string;
}

export interface MultipartCompleteRequest {
  upload_id: string;
  parts: PartInfo[];
}

export interface MultipartCreateRequest {
  folder_id: string;
  company_id: string;
  name: string;
  size_bytes: number;
  content_type: string;
  original_created_at?: string | null;
}

export interface NewFromTemplate {
  folder_id: string;
  name?: string | null;
}

export interface NotificationPrefs {
  muted: string[];
}

/** Competência de uma obrigação, com o estado calculado. */
export interface Obrigacao {
  id: string;
  template_id: string;
  company_id: string;
  period: string;
  period_label: string;
  due_date: string;
  status: string;
  dispensa_motivo: string | null;
  owner_id: string | null;
  score: number;
  satisfied_at: string | null;
  created_at: string;
  updated_at: string;
  notes: string | null;
  reviewed_by: string | null;
  reviewed_at: string | null;
  review_note: string | null;
  template_name: string;
  criticality: string | null;
  department: string | null;
  weight: number | null;
  frequency: string | null;
  legal_basis: string | null;
  requires_review: boolean | null;
  template_description: string | null;
  company_name: string;
  owner_name: string | null;
  reviewer_name: string | null;
  effective_status: string;
  blocking_templates: string[] | null;
  document_expires_at: string | null;
  document_count: number;
  days_late: number;
}

/** Competência com documentos e histórico (GET /obligations/instances/{id}). */
export interface ObrigacaoDetalhe {
  id: string;
  template_id: string;
  company_id: string;
  period: string;
  period_label: string;
  due_date: string;
  status: string;
  dispensa_motivo: string | null;
  owner_id: string | null;
  score: number;
  satisfied_at: string | null;
  created_at: string;
  updated_at: string;
  notes: string | null;
  reviewed_by: string | null;
  reviewed_at: string | null;
  review_note: string | null;
  template_name: string;
  criticality: string | null;
  department: string | null;
  weight: number | null;
  frequency: string | null;
  legal_basis: string | null;
  requires_review: boolean | null;
  template_description: string | null;
  company_name: string;
  owner_name: string | null;
  reviewer_name: string | null;
  effective_status: string;
  blocking_templates: string[] | null;
  document_expires_at: string | null;
  document_count: number;
  days_late: number;
  documents: DocumentoDaObrigacao[];
  history: HistoricoObrigacao[];
}

export interface Organizar {
  paginas: Pagina[];
  modo?: "versao" | "extrair";
  nome?: string | null;
}

export interface Pagina {
  /** Posição da página no PDF atual, a partir de 0. */
  indice: number;
  rotacao?: 0 | 90 | 180 | 270;
}

/** Página da trilha (GET /activity). */
export interface PaginaAtividade {
  results: EventoAtividade[];
  total: number;
  page: number;
  page_size: number;
}

export interface PartInfo {
  part_number: number;
  etag: string;
}

export interface PartUrlRequest {
  upload_id: string;
  part_number: number;
}

/** Pasta da empresa (GET /folders). */
export interface Pasta {
  id: string;
  name: string;
  path: string;
  parent_id: string | null;
  company_id: string;
  created_by: string | null;
  created_at: string;
  my_permission: string | null;
  child_count: number;
  document_count: number;
}

/** Pasta com mais atividade recente da pessoa (GET /folders/frequent). */
export interface PastaFrequente {
  id: string;
  name: string;
  path: string;
  parent_id: string | null;
  company_id: string;
  activity_count: number;
  last_activity: string | null;
}

export interface PastaNaLixeira {
  id: string;
  name: string;
  company_id: string;
  deleted_at: string;
  trash_expires_at: string | null;
  parent_id: string | null;
  original_path: string | null;
  deleted_by_name: string | null;
  document_count: number;
  item_type: "folder";
}

export interface PedidoMudanca {
  status?: "recebido" | "verificando" | "em_andamento" | "concluido" | "negado" | null;
  responsavel_id?: string | null;
  identidade_verificada?: boolean | null;
  identidade_metodo?: string | null;
  prazo?: string | null;
  resposta?: string | null;
  nota?: string | null;
}

export interface PedidoNovo {
  tipo: "confirmacao" | "acesso" | "correcao" | "eliminacao" | "portabilidade" | "anonimizacao" | "informacao" | "revogacao" | "oposicao";
  canal?: "formulario" | "email" | "telefone" | "presencial" | "outro";
  titular_nome: string;
  titular_cpf?: string | null;
  contato?: string | null;
  descricao?: string | null;
}

export interface PedidoPublico {
  tipo: "confirmacao" | "acesso" | "correcao" | "eliminacao" | "portabilidade" | "anonimizacao" | "informacao" | "revogacao" | "oposicao";
  titular_nome: string;
  titular_cpf: string;
  contato: string;
  descricao?: string | null;
}

export interface PermissionUpsert {
  user_id: string;
  company_id: string;
  permission_level: string;
  folder_path?: string | null;
}

/** Pessoa com o que define o que ela vê (GET /companies/{id}/people). */
export interface PessoaDaEmpresa {
  user_id: string;
  username: string | null;
  full_name: string | null;
  is_active: boolean;
  role: string;
  must_change_password: boolean | null;
  email: string | null;
  last_sign_in_at: string | null;
  mfa_enabled: boolean;
  grants: ConcessaoDireta[];
  via_groups: ConcessaoPorGrupo[];
  company_count: number;
  avatar_url: string | null;
}

export interface PolicyCreate {
  company_id: string;
  name: string;
  legal_basis?: string | null;
  notes?: string | null;
  trigger_type?: string;
  trigger_custom_field_id?: string | null;
  duration_months?: number | null;
  start_rule?: string;
  locked?: boolean;
}

export interface PolicyUpdate {
  name?: string | null;
  legal_basis?: string | null;
  notes?: string | null;
  duration_months?: number | null;
  indeterminate?: boolean;
  start_rule?: string | null;
  trigger_type?: string | null;
  trigger_custom_field_id?: string | null;
  locked?: boolean | null;
}

export interface PublicConfirm {
  document_id: string;
  password?: string | null;
}

export interface PublicUploadUrl {
  name: string;
  size_bytes: number;
  content_type?: string;
  sender_name: string;
  password?: string | null;
}

export interface QueueBatch {
  ids: string[];
  status: string;
  notes?: string | null;
  deferred_until?: string | null;
}

export interface QueueDecision {
  status: string;
  notes?: string | null;
  deferred_until?: string | null;
}

export interface QueueExecute {
  confirm_name: string;
}

export interface RefreshRequest {
  refresh_token: string;
}

export interface ReprocessTextRequest {
  company_id: string;
}

/** Quem reservou o documento para edição. */
export interface Reserva {
  user_id: string;
  full_name: string | null;
  note: string | null;
  created_at: string;
}

export interface ResetPasswordRequest {
  access_token: string;
  new_password: string;
}

/** Página da busca (GET /search). */
export interface RespostaBusca {
  results: ResultadoBusca[];
  total: number;
  page: number;
  page_size: number;
  query: string;
  facets: Facetas;
  aproximado?: boolean | null;
  sugestao?: string | null;
  sem_texto?: number | null;
}

export interface RespostaCadastro {
  id: string;
  clientDataJSON: string;
  attestationObject: string;
  name?: string | null;
}

export interface RespostaLogin {
  id: string;
  clientDataJSON: string;
  authenticatorData: string;
  signature: string;
}

/** Documento encontrado pela busca. */
export interface ResultadoBusca {
  id: string;
  name: string;
  file_type: string;
  size_bytes: number;
  sector: string | null;
  competencia: string | null;
  tipo_fiscal: string | null;
  ocr_status: string;
  folder_id: string;
  company_id: string;
  created_at: string;
  folder_name: string | null;
  rank: number | null;
  snippet: string | null;
  folder_path_label: string | null;
  usado_por_mim?: boolean | null;
}

/** Resultado da busca rápida (GET /search/quick). */
export interface ResultadoRapido {
  id: string;
  name: string;
  type: string;
  file_type: string;
  folder_id: string;
  folder_name: string | null;
  rank: number | null;
}

/** O que há abaixo da pasta (GET /folders/{id}/summary). */
export interface ResumoPasta {
  name: string;
  subfolders: number;
  documents: number;
}

export interface RetentionUpdate {
  retention_days: number;
}

export interface ReviewCreate {
  title: string;
  reviewer_id: string;
  due_date: string;
  repeat_months?: 3 | 6 | 12 | null;
}

export interface ReviewDecision {
  decision: string;
  note?: string | null;
}

export interface Saida {
  endpoint: string;
}

export interface SavedSearchCreate {
  company_id: string;
  name: string;
  query: string;
}

export interface SensitivityBody {
  sensitivity: string;
  legal_basis?: string | null;
  purpose?: string | null;
}

export interface ShareCreate {
  resource_type: string;
  resource_id: string;
  password?: string | null;
  expires_in?: string;
  custom_expires_at?: string | null;
  always_latest?: boolean;
  max_views?: number | null;
  allow_download?: boolean;
  terms_text?: string | null;
}

export interface SharePolicy {
  require_password?: boolean;
  max_days?: number | null;
  motivo?: string | null;
}

/** Editar um link depois de criado: validade, senha, limite e download. */
export interface ShareUpdate {
  expires_in?: string | null;
  custom_expires_at?: string | null;
  password?: string | null;
  max_views?: number | null;
  allow_download?: boolean | null;
}

export interface Snooze {
  until: string;
}

export interface TemplateApply {
  target_folder_id?: string | null;
  target_parent_id?: string | null;
  conflito?: "mesclar" | "renomear" | "pular";
  dry_run?: boolean;
}

/** Texto lido do documento (GET /documents/{id}/text). */
export interface TextoDocumento {
  text: string;
  ocr_status: string;
}

export interface UnlockRequest {
  password?: string | null;
  visitor_name?: string | null;
  accepted_terms?: boolean;
}

export interface UpdateProfileRequest {
  full_name: string;
}

export interface UploadRequestCreate {
  company_id: string;
  folder_id: string;
  title: string;
  message?: string | null;
  expires_days?: number;
  password?: string | null;
  max_files?: number;
  obligation_instance_id?: string | null;
}

export interface UploadUrlRequest {
  folder_id: string;
  company_id: string;
  name: string;
  size_bytes: number;
  content_type: string;
  original_created_at?: string | null;
}

export interface ValorFaceta {
  value: string;
  count: number;
}

export interface VersionLabelRequest {
  label?: string | null;
}

export interface VersionUploadRequest {
  size_bytes: number;
  content_type: string;
}

export interface VersionsPolicy {
  keep_days?: number | null;
}

export interface ViewBody {
  name: string;
  folder_id?: string | null;
  shared?: boolean;
  config: Record<string, unknown>;
}

/** Marca d'água (B2.4.7): texto extra, intensidade e onde aparece. */
export interface WatermarkConfig {
  texto?: string | null;
  intensidade?: string;
  previa?: boolean;
  link?: boolean;
}

export interface app__routers__obligations__CatalogApply {
  keys: string[];
  default_owner_id?: string | null;
}

export interface app__routers__obligations__TemplateCreate {
  name: string;
  description?: string | null;
  frequency: string;
  criticality?: string | null;
  department?: string | null;
  sla_days?: number | null;
  weight?: number | null;
  validity_months?: number | null;
  rules_json?: Record<string, unknown> | null;
  active?: boolean | null;
  due_day?: number | null;
  due_month_offset?: number | null;
  due_month?: number | null;
  default_owner_id?: string | null;
  requires_review?: boolean | null;
  legal_basis?: string | null;
  company_id: string;
}

export interface app__routers__obligations__TemplateUpdate {
  name?: string | null;
  description?: string | null;
  frequency?: string | null;
  criticality?: string | null;
  department?: string | null;
  sla_days?: number | null;
  weight?: number | null;
  validity_months?: number | null;
  rules_json?: Record<string, unknown> | null;
  active?: boolean | null;
  due_day?: number | null;
  due_month_offset?: number | null;
  due_month?: number | null;
  default_owner_id?: string | null;
  requires_review?: boolean | null;
  legal_basis?: string | null;
  clear_validity_months?: boolean;
}

export interface app__routers__retention_legal__CatalogApply {
  keys: string[];
}

export interface app__routers__templates__TemplateCreate {
  name: string;
  description?: string | null;
  source_folder_id: string;
}

export interface app__routers__templates__TemplateUpdate {
  name?: string | null;
  description?: string | null;
  source_folder_id?: string | null;
}

/** Resposta de cada rota com contrato declarado (caminho sem /api/v1). */
export interface Respostas {
  "GET /activity": PaginaAtividade;
  "POST /auth/demo-login": LoginResponse;
  "POST /auth/login": LoginResponse;
  "POST /auth/mfa/verify": LoginResponse;
  "POST /auth/refresh": LoginResponse;
  "GET /companies": EmpresaDaPessoa[];
  "GET /companies/{company_id}": Empresa;
  "GET /companies/{company_id}/members": ConcessaoDaEmpresa[];
  "GET /companies/{company_id}/obligations/instances": Obrigacao[];
  "GET /companies/{company_id}/people": PessoaDaEmpresa[];
  "GET /documents": DocumentoNaPasta[];
  "GET /documents/recent": DocumentoRecente[];
  "GET /documents/{document_id}": DocumentoDetalhe;
  "GET /documents/{document_id}/obligations": Obrigacao[];
  "GET /documents/{document_id}/text": TextoDocumento;
  "GET /favorites": Ancorado[];
  "GET /folders": Pasta[];
  "GET /folders/frequent": PastaFrequente[];
  "GET /folders/{folder_id}/summary": ResumoPasta;
  "GET /notifications": ListaAvisos;
  "GET /obligations/instances/{instance_id}": ObrigacaoDetalhe;
  "GET /obligations/instances/{instance_id}/documents": DocumentoDaObrigacao[];
  "GET /search": RespostaBusca;
  "GET /search/quick": ResultadoRapido[];
  "GET /shares": LinkCompartilhado[];
  "GET /trash": Lixeira;
}
