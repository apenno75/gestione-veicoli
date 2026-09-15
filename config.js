// =====================================================================
//  Collegamento al progetto Supabase.
//  Trovi questi due valori in Supabase: Project Settings → API.
//
//  La chiave "anon" è pensata per stare in una pagina pubblica: da sola
//  non dà accesso a niente, perché le regole Row Level Security del
//  database lasciano leggere e scrivere soltanto le righe di chi ha
//  fatto l'accesso. La chiave "service_role", invece, non va mai messa
//  qui: quella vive solo tra i segreti della Edge Function.
// =====================================================================

export const CONFIG = {
  SUPABASE_URL: 'https://erukzvrtjnvyzjvfuirn.supabase.co',
  SUPABASE_ANON_KEY: 'sb_publishable_FDhQ03affjzeyhCHuoKulg_Rp7PdyLM',
};
