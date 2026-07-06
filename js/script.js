"use strict";

/* ==========================================
TODAY'S THOUGHT
========================================== */

const thoughts = [

"Touch Moss. Not Leverage.",

"One chart changed everything.",

"Just one more chart.",

"Every candle tells a story.",

"Trust Your Claws.",

"Green candles heal emotions.",

"Strong claws never panic.",

"Paper hands never touch moss.",

"Buy fear. Ignore noise.",

"Charts don't sleep."

];

const thoughtText=document.getElementById("thoughtText");

const newThought=document.getElementById("newThought");

if(newThought){

newThought.onclick=()=>{

const random=Math.floor(

Math.random()*thoughts.length

);

thoughtText.innerHTML=thoughts[random];

};

}

/* ==========================================
GAME
========================================== */

const gameArea=document.getElementById("gameArea");

const scoreText=document.getElementById("score");

const timerText=document.getElementById("timer");

const startButton=document.getElementById("startGame");

let score=0;

let time=30;

let playing=false;

let spawnInterval;

let timerInterval;

/* ==========================================
START GAME
========================================== */

startButton.onclick=startGame;

function startGame(){

if(playing)return;

playing=true;

score=0;

time=30;

scoreText.innerHTML=score;

timerText.innerHTML=time;

gameArea.innerHTML="";

spawnInterval=setInterval(

spawnCandle,

500

);

timerInterval=setInterval(

updateTimer,

1000

);

}
/* ==========================================
UPDATE TIMER
========================================== */

function updateTimer(){

time--;

timerText.innerHTML=time;

if(time<=0){

finishGame();

}

}

/* ==========================================
SPAWN CANDLE
========================================== */

function spawnCandle(){

if(!playing)return;

const candle=document.createElement("div");

const green=Math.random()>0.35;

candle.className="candle";

if(green){

candle.classList.add("green");

}else{

candle.classList.add("red");

}

const x=Math.random()*(gameArea.clientWidth-20);

let y=-50;

const speed=2+Math.random()*3;

candle.style.left=x+"px";

candle.style.top=y+"px";

gameArea.appendChild(candle);

const fall=setInterval(()=>{

if(!playing){

clearInterval(fall);

candle.remove();

return;

}

y+=speed;

candle.style.top=y+"px";

if(y>gameArea.clientHeight){

clearInterval(fall);

candle.remove();

}

},16);

/* ==========================================
CLICK CANDLE
========================================== */

candle.onclick=()=>{

if(!playing)return;

clearInterval(fall);

if(green){

score++;

showPopup("+1","#00ff88");

}else{

score=Math.max(0,score-2);

showPopup("-2","#ff5577");

}

scoreText.innerHTML=score;

candle.remove();

};

}

/* ==========================================
POPUP SCORE
========================================== */

function showPopup(text,color){

const popup=document.createElement("div");

popup.className="scorePopup";

popup.innerHTML=text;

popup.style.color=color;

popup.style.left="50%";

popup.style.top="50%";

gameArea.appendChild(popup);

setTimeout(()=>{

popup.remove();

},600);

}
/* ==========================================
FINISH GAME
========================================== */

function finishGame(){

playing=false;

clearInterval(spawnInterval);

clearInterval(timerInterval);

let rank="🥉 PAPER HANDS";

if(score>=10){

rank="🥈 STRONG HANDS";

}

if(score>=20){

rank="🥇 DIAMOND CLAWS";

}

if(score>=35){

rank="👑 LEGENDARY CRAB";

}

gameArea.innerHTML=

`

<div class="gameOver">

<h2>${rank}</h2>

<p>Final Score</p>

<h1>${score}</h1>

<button id="playAgain" class="primary-btn">

PLAY AGAIN

</button>

</div>

`;

document

.getElementById("playAgain")

.onclick=()=>{

startGame();

};

}

/* ==========================================
AUTO THOUGHT
========================================== */

setInterval(()=>{

const random=Math.floor(

Math.random()*thoughts.length

);

if(thoughtText){

thoughtText.innerHTML=

thoughts[random];

}

},7000);

/* ==========================================
GAME POPUP STYLE
========================================== */

const style=document.createElement("style");

style.innerHTML=`

.scorePopup{

position:absolute;

left:50%;

top:50%;

transform:translate(-50%,-50%);

font-size:40px;

font-weight:800;

animation:popup .6s forwards;

pointer-events:none;

text-shadow:0 0 12px black;

z-index:99;

}

@keyframes popup{

0%{

opacity:0;

transform:translate(-50%,20px);

}

30%{

opacity:1;

transform:translate(-50%,0);

}

100%{

opacity:0;

transform:translate(-50%,-50px);

}

}

.gameOver{

position:absolute;

inset:0;

display:flex;

flex-direction:column;

justify-content:center;

align-items:center;

background:rgba(10,10,18,.94);

backdrop-filter:blur(8px);

text-align:center;

}

.gameOver h2{

font-family:'Anton',sans-serif;

font-size:42px;

margin-bottom:15px;

letter-spacing:2px;

}

.gameOver p{

font-size:20px;

color:#cccccc;

}

.gameOver h1{

font-size:72px;

margin:15px 0 30px;

color:#9d6cff;

}

`;

document.head.appendChild(style);

/* ==========================================
PREVENT IMAGE DRAG
========================================== */

document

.querySelectorAll("img")

.forEach(img=>{

img.draggable=false;

});

/* ==========================================
CONSOLE
========================================== */

console.log(

"%c🦀 CRABSEM",

"font-size:28px;color:#9d6cff;font-weight:bold"

);

console.log(

"Touch Moss. Trust Your Claws.");

/* ==========================================
END OF FILE
========================================== */