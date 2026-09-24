MINIBALL ONLINE — XAMPP + NODE.JS
===================================

WYMAGANIA
---------
- XAMPP (Apache)
- Node.js LTS
- dwa komputery w tej samej sieci LAN ALBO serwer z publicznym IP/portem

STRUKTURA
---------
haxball_multiplayer/
  index.php
  package.json
  server.js
  assets/
    style.css
    game.js

INSTALACJA
----------
1. Skopiuj folder "haxball_multiplayer" do:
   C:\xampp\htdocs\

2. Zainstaluj Node.js LTS.

3. Otwórz CMD w folderze projektu:
   cd C:\xampp\htdocs\haxball_multiplayer

4. Zainstaluj WebSocket:
   npm install

5. Uruchom serwer gry:
   node server.js

Powinno pojawić się:
MiniBall server listening on ws://localhost:8080

6. W XAMPP uruchom Apache.

7. Na komputerze serwera:
   http://localhost/haxball_multiplayer/

MULTIPLAYER W LAN
-----------------
Na komputerze serwera sprawdź adres IPv4:
   ipconfig

Przykład:
   IPv4 Address . . . . . : 192.168.1.50

Na drugim komputerze otwórz:
   http://192.168.1.50/haxball_multiplayer/

WAŻNE:
Strona HTTP może działać z Apache, ale WebSocket gry łączy się z:
   ws://ADRES_SERWERA:8080

Jeżeli Windows Firewall zapyta o node.exe — zezwól na połączenia w sieci prywatnej.

PORTY
-----
Apache: 80
WebSocket: 8080

INTERNET
--------
Żeby osoby spoza twojej sieci mogły wejść:
- serwer musi być osiągalny z internetu,
- port TCP 8080 musi być dostępny,
- router/firewall musi przekazywać port 8080 na komputer z Node.js,
- przy hostingu VPS można uruchomić Node.js bez przekierowania domowego routera.

BEZPIECZEŃSTWO / ARCHITEKTURA
-----------------------------
Serwer jest autorytatywny dla fizyki: klient wysyła wejście (klawisze), a serwer oblicza pozycje, kolizje, piłkę, gole i czas meczu. Klient renderuje otrzymany stan.

Gra obsługuje drużyny CZERWONI / NIEBIESCY + widzów, panel pokoju z opcjami meczu, czat i liczniki FPS/Ping. Nie ma jeszcze kont użytkowników, bazy MySQL, matchmakingu rankingowego ani TLS/WSS.

NOWY POKÓJ
----------
Kliknij CREATE ROOM. Kod ma 6 znaków.
Drugi gracz wpisuje kod w JOIN (przycisk LINK w pokoju kopiuje gotowy link z kodem).

MECZ
----
Gospodarz (jego nick jest żółty na liście) ustawia drużyny i klika START GAME —
mecz nie startuje sam. Nikt inny nie może go wystartować.

W panelu pokoju:
  Auto   — dopełnia i wyrównuje drużyny
  Rand   — losowo tasuje wszystkich między CZERWONYCH i NIEBIESKICH
  Lock   — blokuje zmiany drużyn, nowi wchodzą jako widzowie
  Reset  — zeruje wynik

Zawodników przenosi się między kolumnami przeciąganiem (przeciągnij kafelek
na CZERWONYCH, WIDZÓW albo NIEBIESKICH) albo strzałkami przy nagłówkach
kolumn. Gospodarz może przeciągać każdego, gracz tylko siebie.

Pod listami są pola liczbowe (można wpisać wartość albo klikać strzałki):
  Time limit  — minuty, 0 = bez limitu
  Score limit — gole, 0 = bez limitu
  Max players — 2 do 24
  Stadium     — przycisk PICK otwiera wybór boiska
W czasie meczu panel się schowuje, a boisko zajmuje całe okno. Rozgrywkę
przerywa się przez MENU → "Stop match and return to the room".

Klawisze: WASD / strzałki — ruch, X lub SPACJA — strzał, TAB (przytrzymany)
— kamera przybliża się do własnego zawodnika i pokazuje strzałkę w stronę
piłki, ENTER — czat, ESC — zamknięcie czatu lub okna.

GOLE
----
Mecz nie zatrzymuje się po golu. Na środku ekranu pojawia się animowany
napis "Red Scored!" albo "Blue Scored!" w kolorze drużyny, która zdobyła
gola, a gra toczy się dalej — po chwili piłka wraca na środek. Pod napisem
widnieje nazwisko zawodnika, który ostatni dotknął piłki; jeśli był to gracz
drugiej drużyny, dopisek brzmi "Own goal — <nick>", a gol liczy się
przeciwnikom.

WZNAWIANIE (KICK OFF)
---------------------
Mecz zaczyna się od wznowienia, a nie od gwizdka: piłka leży na środku, a
drużyna, która nie wznawia, nie przejdzie na połowę przeciwnika. Ta ściana
jest niewidzialna — widać tylko jej skutek, bo zawodnicy zatrzymują się przy
linii środkowej. Kto wznawia, mówi plakietka przy zegarze: "RED KICK OFF"
albo "BLUE KICK OFF".

Ściana stoi tak długo, aż drużyna wznowienia dotknie piłki: wtedy znika od
razu, bez opóźnienia i bez timera. Nie ma "i tak się otworzy po chwili" —
jeżeli nikt nie podejdzie do piłki, wznowienie trwa, a zegar meczu stoi
(czas leci tylko w grze). Piłkę rozgrywa się jak w HaxBallu: wchodzi się na
nią i popycha ją w stronę przeciwnika. Po golu wznowienie należy do drużyny,
która straciła bramkę.

STADIONY I WŁASNE MAPY
----------------------
PICK w panelu pokoju otwiera listę boisk: Small, Medium i Big. Na dole tego
okna jest przycisk "Load .hbs map…", który wczytuje mapę z HaxBall / HaxMaps
(te same pliki .hbs, które otwiera oryginalny edytor). Z mapy czytane są
ściany, łuki, słupki, siatki, bramki, płaszczyzny trzymające graczy w boisku,
rozmiar i kolor piłki, przyspieszenie i siła strzału, pozycje startowe oraz
murawa: kolor (bg.color) i rodzaj (bg.type — grass, hockey albo none). Bez
nich boisko dostaje zieloną trawę jak boiska wbudowane, a "hockey" daje
szary asfalt z ziarnem. Wczytana mapa jedzie do wszystkich w pokoju, więc
każdy gra na tym samym.

Mapa jest sprawdzana przed wczytaniem: do 2000 wierzchołków, 2000 segmentów,
200 dysków, 100 płaszczyzn i 8 bramek, współrzędne do ±20000, a boisko musi
mieć bramkę dla każdej z drużyn. Plik większy niż 256 KB, uszkodzony albo
bez bramki jest odrzucany z komunikatem, a pokój i trwający mecz grają
dalej.

TŁO POKOJU
----------
W ustawieniach (VISUAL → "Room background") wybiera się tło, na którym stoi
panel pokoju przed meczem:

  Blue haze              — niebieska mgła, która powoli płynie (domyślne)
  Grey with blue stripes — szarość listy pokoi z przygaszonymi niebieskimi
                           pasami płynącymi w stronę prawego dolnego rogu
  Classic dark stripes   — ciemne pasy, tło sprzed zmiany

BALL IMAGES
-----------
W ustawieniach (GENERAL → "Your ball image") można wgrać PNG, GIF, JPEG albo
WebP do 30 KB i wtedy piłka zawodnika pokazuje ten obrazek zamiast numeru.
GIF-y są animowane. Bez obrazka zawodnik dostaje numer koszulki w swojej
drużynie; numery wyłącza się w VISUAL → "Number the players".

Ustawienia (ikonka ⚙ w prawym górnym rogu) mają zakładki GENERAL i VISUAL:
nick, dołączanie jako widz, odświeżanie listy, liczba linii czatu, obrazek
piłki oraz liczniki FPS/Ping, nazwy graczy, numery, czat w meczu, tło pokoju,
pasy trawy, podświetlenie własnej postaci. Zapisywane w localStorage
przeglądarki.

UWAGA
-----
Projekt jest inspirowany mechaniką gier typu HaxBall. Nie zawiera kodu ani zasobów HaxBall.
