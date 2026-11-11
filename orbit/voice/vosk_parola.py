# Parola di attivazione "Orbit" in locale con Vosk (Kaldi, modello piccolo italiano): leggera, offline, separata da Whisper.
# Il processo e figlio di Orbit (orbit/voice/parola.js): legge l'audio da stdin, scrive su stdout una riga JSON per ogni pacchetto.
# Nessun audio e nessun testo viene salvato: il riconoscimento serve solo a capire se e stata detta la parola, il resto si scarta.
#
# Pacchetti in ingresso: 1 byte di tipo + 4 byte di lunghezza (little endian) + dati.
#   'A' audio PCM 16 bit mono 16 kHz   ->  {"attivata": false, "campioni": n}  oppure  {"attivata": true, "fine": secondi, "campioni": n}
#       campioni = quanti campioni sono arrivati dall'ultimo azzeramento: chi chiama lo confronta con i propri conti e si riallinea se un
#       pacchetto e andato perso o questo processo e ripartito.
#   'R' azzera il flusso (pausa, nuova sessione)  ->  {"azzerato": true}
# "fine" e la fine della parola di attivazione, in secondi dall'ultimo azzeramento: chi chiama la usa per tagliare l'audio del comando.
# Se stdin si chiude (Orbit si e fermato), il processo esce da solo.
import sys, json, struct

def scrivi(o):
    sys.stdout.write(json.dumps(o) + '\n'); sys.stdout.flush()

def main():
    if len(sys.argv) < 3:
        scrivi({'errore': 'uso: vosk_parola.py <modello> <parole json>'}); return 2
    try:
        from vosk import Model, KaldiRecognizer, SetLogLevel
        SetLogLevel(-1)
        modello = Model(sys.argv[1])
    except Exception as e:  # modello o libreria mancanti
        scrivi({'errore': 'Vosk non disponibile: %s' % e}); return 1
    parole = set(json.loads(sys.argv[2]))
    # varianti: grafie che il modello puo dare a «Orbit» (per esempio «orbita»). Valgono solo come PRIMA parola dell'enunciato, per non
    # scattare quando si parla di orbite; vuoto per impostazione predefinita, si aggiungono dopo averle misurate (ORBIT_STT_VARIANTI).
    varianti = set(json.loads(sys.argv[3])) if len(sys.argv) > 3 else set()

    def nuovo():
        r = KaldiRecognizer(modello, 16000); r.SetWords(True); return r

    rec = nuovo()
    scrivi({'pronto': True})
    ingresso = sys.stdin.buffer

    def fine_parola(risultato):
        dette = risultato.get('result', [])
        trovate = [w for w in dette if w.get('word') in parole]
        if not trovate and dette and dette[0].get('word') in varianti:
            trovate = [dette[0]]
        return trovate[-1]['end'] if trovate else None

    def contiene(parziale):
        parole_dette = parziale.split()
        return bool(parole.intersection(parole_dette)) or bool(parole_dette and parole_dette[0] in varianti)

    campioni = 0

    while True:
        testa = ingresso.read(5)
        if len(testa) < 5:
            return 0
        tipo, n = testa[:1], struct.unpack('<I', testa[1:])[0]
        dati = ingresso.read(n) if n else b''
        if len(dati) < n:
            return 0
        if tipo == b'R':
            rec = nuovo(); campioni = 0; scrivi({'azzerato': True}); continue
        if tipo != b'A':
            scrivi({'errore': 'pacchetto sconosciuto'}); continue
        campioni += n // 2
        fine = None
        if rec.AcceptWaveform(dati):
            fine = fine_parola(json.loads(rec.Result()))
        else:
            parziale = json.loads(rec.PartialResult()).get('partial', '')
            if contiene(parziale):
                # la parola e nel risultato parziale: si chiude subito l'enunciato per avere i tempi esatti delle parole
                finale = json.loads(rec.FinalResult())
                fine = fine_parola(finale)
                if fine is None:
                    # il risultato finale non la conferma (succede): il riconoscitore e gia azzerato e non ci sarebbe un secondo tentativo,
                    # quindi ci si fida del parziale. La parola e l'ultima cosa sentita: fine = fine dell'ultima parola, o dell'audio ricevuto
                    dette = finale.get('result', [])
                    fine = dette[-1]['end'] if dette else campioni / 16000.0
        scrivi({'attivata': True, 'fine': round(fine, 3), 'campioni': campioni} if fine is not None else {'attivata': False, 'campioni': campioni})

if __name__ == '__main__':
    sys.exit(main())
