# wopr-dashboard

Interface web de supervision et de pilotage d'un serveur Linux domestique
partagé : CPU, mémoire, températures, ventilateurs, GPU NVIDIA, conteneurs
Docker, processus, stockage, réseau, services systemd — en lecture **et** en
écriture, avec journal d'audit.

Écrit pour une machine réelle, en service quotidien : un Ryzen 7 sous Ubuntu
avec une carte NVIDIA, un démon Docker partagé entre deux administrateurs, une
pile Ollama, et personne pour surveiller tout cela en permanence.

<!-- Captures d'écran : déposer les images dans `docs/` puis décommenter.
![Vue d'ensemble](docs/overview.png)
![Vue GPU](docs/gpu.png)
-->

## Le parti pris

**Tout ce qui est affiché est mesuré, et tout bouton visible agit.**

Le projet est parti d'une maquette d'interface, jolie et entièrement fausse :
des jauges alimentées par des données simulées, des interrupteurs branchés sur
rien. La reprendre a surtout consisté à décider, levier par levier, ce qu'on
savait réellement faire sur cette machine — et à **supprimer le reste** plutôt
que de laisser l'interface annoncer des effets qui ne se produisent pas. La
liste de ce qui a été retiré, et pourquoi, est plus bas : elle en dit autant sur
le projet que la liste des fonctionnalités.

Le corollaire : là où la machine ne peut pas fournir une information, l'interface
affiche une indisponibilité motivée, jamais un zéro plausible. Les types TypeScript
disent `| null` partout où la mesure peut manquer, et le backend explique pourquoi.

## Pile technique

| | |
|---|---|
| **Backend** | Python 3.12, FastAPI, WebSocket pour le temps réel |
| **Frontend** | React 18, TypeScript, Vite, Tailwind CSS |
| **Mesures** | `/proc`, `/sys`, `hwmon`, NVML (`pynvml`), SMART, API Docker, systemd |
| **Historique** | PostgreSQL 18, échantillon toutes les 5 s, moyennes par pas |
| **Audit** | SQLite — qui, quoi, sur quoi, avec quel résultat |
| **Livraison** | Dockerfile multi-étapes, un seul conteneur, `docker compose` |
| **Notifications** | Telegram, avec règles par famille d'alerte et heures calmes |

Environ 14 000 lignes, sans framework de dashboard tout fait : les vues, les
graphes (SVG à la main) et le contrôle des ventilateurs sont écrits pour ce cas.

## Ce qu'il faut savoir avant de lire le code

- **La documentation est en français**, comme la machine qu'elle décrit.
- Les commentaires renvoient parfois à un document d'organisation interne
  (`wopr-server-rules.md`, §1.5, §4.2, §7…) qui n'est pas publié : il fixe les
  conventions du serveur entre ses deux administrateurs. Les décisions qu'il
  motive sont, elles, expliquées sur place.
- Trois fichiers décrivent la machine plutôt que le programme et ne sont donc
  pas versionnés — `.env`, `config/settings.yaml`, `config/owners.yaml`. Leurs
  modèles le sont : `.env.example` et `config/owners.example.yaml`.

---

## En bref

| | |
|---|---|
| **Compte** | un seul, `admin` — empreinte scrypt dans le `.env` |
| **Adresse** | `http://<ip-lan>:8080/` — LAN uniquement, jamais exposé |
| **GPU** | NVML, en lecture et pour la limite de puissance |
| **Dépendances** | démon Docker, module noyau `nct6775` (ventilateurs), Ollama (vue des modèles) |
| **Base** | PostgreSQL 18, conteneur `wopr-dashboard-db`, `127.0.0.1:5434` |
| **Licence** | MIT |

---

## Ce que le dashboard fait réellement

**Lecture** — CPU (par thread, gouverneur, EPP, puissance RAPL), RAM et swap,
températures (11 capteurs : k10temp, nct6799, NVMe, DDR5, iGPU, NIC), ventilateurs
(tr/min et PWM réels), GPU NVIDIA via NVML, conteneurs Docker avec statistiques
en direct, processus, montages avec SMART NVMe, interfaces réseau et ports en
écoute, services systemd, mises à jour en attente.

**Actions** — start/stop/restart/suppression de conteneur, `docker compose`
up/down/restart/pull par stack, kill et renice de processus, limite de puissance
GPU, chargement/déchargement/épinglage de modèles Ollama, pilotage et courbes de
ventilation, changement de mode machine, redémarrage de service, vidage des
caches, redémarrage de la machine.

**Réglable** — l'onglet **Paramètres** expose la totalité de la configuration :
seuils d'alerte, définitions des modes, règles de notification, cadences,
identité, mot de passe administrateur. Voir « Configuration » plus bas.

**Journalisé** — chaque action mutante écrit dans `data/audit.db` : qui, quoi,
sur quoi, avec quel résultat.

### Ce qui a été retiré, et pourquoi

La maquette d'origine affichait des leviers sans mécanisme derrière. Plutôt que de
les laisser mentir, ils ont été supprimés :

- **Mises à jour auto, notifications, mise en veille, limites de ressources
  conteneurs** dans les modes — aucun code ne les appliquait.
- **Planification horaire des modes** — non implémentée.
- **Extinction de la machine** — un serveur sans accès physique ni Wake-on-LAN
  configuré ne se rallume pas.
- **Redémarrage du démon Docker** — tuerait le dashboard lui-même en même temps
  que tous les autres conteneurs, sans rien laisser pour le signaler.
- **Palmarès des plus gros répertoires** — supposait un parcours récursif qui
  n'existait pas.
- **Choix du GPU cible et de la fenêtre de contexte** au chargement d'un modèle —
  l'API d'Ollama ne permet pas de les imposer.
- **Valeurs des variables d'environnement** des conteneurs — plusieurs stacks de
  cette machine y stockent des jetons et des mots de passe. Seuls les noms sont
  affichés.

---

## Installation

```bash
git clone https://github.com/dratios/wopr-dashboard.git
cd wopr-dashboard

# 1. Secrets : secret de session + empreinte du mot de passe administrateur
python3 scripts/wopr-passwd.py --secret admin

cp .env.example .env
chmod 600 .env
$EDITOR .env          # y coller WOPR_SESSION_SECRET et WOPR_USERS,
                      # et régler BIND_ADDR sur l'IP LAN de la machine
echo "WOPR_DB_PASSWORD=$(openssl rand -hex 24)" >> .env

# 2. Qui administre la machine (voir « Attribution des conteneurs » plus bas)
cp config/owners.example.yaml config/owners.yaml
$EDITOR config/owners.yaml

# 3. Construction et démarrage
docker compose up -d --build

# 4. Vérification — la sonde publique ne demande pas de session
curl -s "http://$(grep ^BIND_ADDR .env | cut -d= -f2):8080/api/status" \
  | python3 -m json.tool
```

Puis ouvrir `http://<ip-lan>:8080/` depuis un poste du réseau local.

**`BIND_ADDR` n'est pas un détail** : le dashboard est root-équivalent sur la
machine (voir plus bas) et ne connaît qu'un compte. Il écoute l'IP du LAN, ou la
boucle locale, jamais `0.0.0.0`.

### Module des ventilateurs

Le Super I/O de la carte (**Nuvoton NCT6799D**) n'est pas détecté par défaut.
Sans lui, aucun tr/min ni contrôle PWM — l'interface le signale explicitement.

```bash
sudo modprobe nct6775
echo nct6775 | sudo tee /etc/modules-load.d/nct6775.conf   # au démarrage
```

Contrairement à ce qu'on lit souvent pour les cartes ASUS, `acpi_enforce_resources=lax`
s'est révélé **inutile** ici : le module se charge tel quel, sans reboot.

---

## Exceptions aux conventions `§4.3`

Trois interdits du document d'organisation sont levés pour cette stack. Ils sont
la raison d'être du dashboard, pas des raccourcis.

| Exception | Pourquoi |
|---|---|
| `privileged: true` | Écrire dans `/sys` (gouverneur CPU, PWM des ventilateurs) et entrer dans les namespaces de l'hôte via `nsenter`. |
| `./.env:/host-env` | Écrire les réglages lus à la création du conteneur. Aucun privilège nouveau : ce conteneur est déjà root-équivalent, et l'allowlist de `hostexec.py` n'est pas touchée. |
| `pid: host` | Lister les processus réels de la machine et rattacher un port en écoute à son processus. Sans cela, on ne verrait que les processus du conteneur. |
| `network_mode: host` | Mesurer le trafic réel des interfaces et lister les ports réellement ouverts. Permet aussi d'atteindre Ollama sur `127.0.0.1:11434`. |

**Conséquence assumée** : ce conteneur est root-équivalent sur wopr. Les garde-fous
ne sont donc pas dans l'isolation Docker, mais dans :

1. l'authentification obligatoire sur toutes les routes (scrypt, 2^14 itérations,
   limitation à 5 tentatives par tranche de 5 minutes) ;
2. l'écoute sur la seule IP du LAN, jamais `0.0.0.0` ;
3. l'allowlist de `server/hostexec.py` — **le seul endroit du code qui exécute des
   commandes sur l'hôte**. Un binaire absent de cette liste ne sera jamais lancé.
   C'est le fichier à relire pour savoir ce que le dashboard peut faire à la machine ;
4. le journal d'audit nominatif de chaque mutation ;
5. la stack `jarvis-agent`, hors périmètre : ses actions sont refusées côté API.

---

## Configuration

Tout se règle depuis l'onglet **Paramètres** du dashboard. Les fichiers restent
modifiables à la main : une écriture depuis l'interface conserve commentaires,
propriétaire et droits, et dépose une sauvegarde `.bak-<horodatage>`.

### Où atterrit quoi

| Fichier | Contenu | Application |
|---|---|---|
| `config/settings.yaml` | réglages modifiés depuis l'interface, règles de notification, empreinte du mot de passe | **à chaud** |
| `config/thresholds.yaml` | seuils d'alerte, avec surcharge par point de montage | **à chaud** (relu) |
| `config/modes.yaml` | définition des modes et de leurs leviers | **à chaud** (relu) |
| `config/owners.yaml` | identités des administrateurs, attribution par défaut | **à chaud** (relu) |
| `.env` | variables lues à la création du conteneur | **à froid** |
| `data/state.json` | état d'exécution (mode actif, courbes, acquittements) | — |

**Précédence** : `settings.yaml` > variable d'environnement > défaut du code. Le
`.env` n'est donc pas devenu inutile : il reste la valeur d'amorçage, et le
moyen de se dépanner si le fichier de réglages devient illisible. Supprimer une
clé de `settings.yaml` la fait retomber sur le `.env` ; supprimer le fichier
entier ramène le dashboard à sa configuration d'origine.

### Ce qui demande une recréation

`BIND_ADDR`, `BIND_PORT`, `WOPR_SESSION_SECRET`, `WOPR_COOKIE_SECURE` et les
paramètres de la base sont lus **avant** que Python ne tourne : uvicorn choisit
son adresse d'écoute, et compose interpole le `.env` à la création du conteneur.
Le dashboard les écrit quand même dans le `.env`, puis affiche un bandeau — sur
toutes les vues — avec la commande à lancer :

```bash
cd /chemin/de/la/stack && sudo docker compose up -d
```

Un `restart` ne suffit pas : compose ne relit le `.env` qu'à la recréation.

### Les listes de conteneurs des modes

Elles sont vides par défaut, volontairement. Sur une machine partagée, un mode ne
doit pas couper par surprise un service qui n'est pas le vôtre — l'enregistreur
vidéo de quelqu'un d'autre, par exemple. L'éditeur de modes rappelle
l'avertissement à l'écran.

`data/` contient le journal d'audit (`audit.db` — actions **et** notifications)
et l'état persistant (`state.json` : mode actif, minuterie de retour, consignes
de ventilation, acquittements d'alertes). **À sauvegarder**, contrairement au reste.

---

## Notifications Telegram

Le filtrage ne se réduit plus à un niveau minimal global. Dans
**Paramètres → Notifications** :

- **Par famille d'alerte** — quatorze familles (températures, ventilateurs,
  disques, charge, mémoire, VRAM, température GPU, conteneurs, redémarrages en
  boucle, démon Docker, interfaces, passerelle, redémarrage requis, pare-feu),
  chacune réglable sur *hérité / jamais / critiques / avertissements et plus /
  tout*, avec une case pour notifier — ou non — la résolution.
- **Délai de confirmation** — n'envoyer qu'après N secondes de persistance. Une
  pointe de charge de trois secondes ne réveille plus personne.
- **Heures calmes** — plage de silence, avec exception possible pour les
  critiques ; ce qui est retenu part groupé à la fin de la plage.
- **Groupement**, **anti-répétition**, **relance périodique**, **débit maximal**
  (avec message de synthèse au-delà).
- **Événements d'exploitation** — changement de mode, redémarrage de la machine,
  action sur un conteneur qui n'est pas le vôtre, blocage après échecs de
  connexion, démarrage du dashboard. Chacun activable séparément : sur une
  machine à deux administrateurs, c'est ce qu'on veut voir passer.
- **Journal sur 30 jours** — ce qui est parti, ce qui a été retenu, et le motif
  exact de chaque suppression. Sans lui, les règles seraient invérifiables.

Le bouton de test utilise les valeurs **saisies** dans le formulaire, avant
enregistrement, et affiche l'erreur exacte renvoyée par l'API Telegram.

---

## Historique des graphes (PostgreSQL)

Les graphes proposent 1 min, 5 min, 1 h et 6 h. Au-delà de quelques minutes, ils
lisent le service `db` de cette stack : un échantillon toutes les 5 s, une ligne
par métrique (`cpu`, `tempMax`, `netRx`, `netTx`, `temp:<sonde>`, `fan:avg`…).
L'API renvoie au plus 360 points par courbe, moyennés côté base (pas de 5 s
jusqu'à 5 min, 10 s sur 1 h, 1 min sur 6 h), et chaque graphe se rafraîchit en
direct. Une période sans mesure (dashboard arrêté) apparaît comme un trou.

- **Conservation** : `WOPR_HISTORY_RETENTION_H` (24 h par défaut), purge toutes
  les 10 minutes. Quelques dizaines de Mo pour 24 h.
- **Facultative** : si la base est arrêtée, le dashboard fonctionne, les
  échantillons attendent en mémoire (1 h au plus) et les graphes retombent sur
  les dernières minutes, avec un avertissement. `GET /api/status` indique
  `historyDb`.
- **Pas de sauvegarde nécessaire** : ce ne sont que des mesures, reconstituées
  en 6 h de fonctionnement.

---

## Sécurité du pilotage des ventilateurs

Prendre la main sur un ventilateur la retire au Smart Fan IV du BIOS. Trois
protections, dans `server/fans.py` :

1. **Rien n'est touché par défaut.** Tous les ventilateurs restent en mode chip
   tant que personne ne demande explicitement autre chose.
2. **Chien de garde thermique.** Un capteur au-delà de son seuil critique rend
   immédiatement tous les ventilateurs à la carte mère, avec entrée d'audit.
3. **Restitution à l'arrêt.** Le `lifespan` de FastAPI rend le pilotage au BIOS
   quand le conteneur s'arrête — d'où le `exec` dans le `CMD` du Dockerfile, qui
   garantit que `uvicorn` reçoit bien le `SIGTERM`.

---

## Attribution des conteneurs

Sur une machine partagée, savoir à qui appartient un conteneur n'est pas
cosmétique : c'est ce qui déclenche une confirmation renforcée avant d'arrêter
quelque chose qui n'est pas à soi, et ce qui donne son sens au journal d'audit.

Les identités sont **déclarées dans `config/owners.yaml`** (modèle :
`owners.example.yaml`), pas dans le code — le dépôt ne nomme donc personne, et
ajouter un troisième administrateur ne demande pas de recompiler :

```yaml
owners:
  - id: admin
    label: "@admin"
    tone: cyan
    hints: [mon-appli]      # devine le propriétaire d'un conteneur non étiqueté
```

L'interface se dessine à partir de cette liste : cartes de synthèse, filtres,
badges, liste déroulante des Paramètres. Le fichier est relu à chaud.

L'étiquette Docker reste la source d'autorité (§4.2) ; les `hints` ne servent
qu'aux conteneurs qui n'en portent pas. Pour rendre l'attribution explicite :

```yaml
services:
  mon-service:
    labels:
      com.wopr.owner: "admin"
```

Sur une machine à plusieurs administrateurs, cela se décide **avec** les
personnes concernées : leurs fichiers compose sont les leurs.

---

## Exploitation

```bash
docker compose logs -f                      # journaux du dashboard
docker compose up -d                        # après modification du .env
docker compose up -d --build                # après modification du code
docker compose down                         # arrêt (ventilateurs rendus au BIOS)
```

`config/` n'a plus besoin d'un `restart` : les trois fichiers sont relus à chaud.

Dépannage : `GET /api/status` indique sans authentification si le démon Docker,
NVML et l'accès à l'hôte répondent.

---

## Licence

MIT — voir [LICENSE](LICENSE).
