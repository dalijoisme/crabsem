/* ===========================================================
   CRABSEM V2
   PART 1 / 3
===========================================================*/

/* -----------------------
Mouse Glow
----------------------- */

const glow = document.createElement("div");
glow.className = "mouse-glow";
document.body.appendChild(glow);

document.addEventListener("mousemove",(e)=>{

glow.style.left=e.clientX+"px";
glow.style.top=e.clientY+"px";

});

/* -----------------------
Quotes
----------------------- */

const thoughts=[

"Touch moss before touching leverage.",

"One more chart won't fix your sleep.",

"Strong hands grow during red candles.",

"Memes are temporary. Community lasts.",

"Buy conviction. Not green candles.",

"Every dip teaches something.",

"The strongest communities keep posting through every dip.",

"Stay based.",

"Touch grass. Touch moss. Not panic.",

"Don't marry charts. Marry conviction.",

"Green candles come to patient holders.",

"Zoom out.",

"Be early. Stay humble.",

"Diamond hands aren't born. They're built.",

"Don't chase pumps. Build communities.",

"Memes win because people care.",

"Patience compounds.",

"Conviction beats emotion.",

"Stay weird.",

"Touch Moss."

];

const quote=document.getElementById("quote");

const button=document.getElementById("newQuote");

function randomQuote(){

const r=Math.floor(Math.random()*thoughts.length);

quote.innerHTML='"'+thoughts[r]+'"';

}

randomQuote();

button.addEventListener("click",randomQuote);

/* -----------------------
Scroll Reveal
----------------------- */

const reveal=document.querySelectorAll("section");

const observer=new IntersectionObserver(entries=>{

entries.forEach(entry=>{

if(entry.isIntersecting){

entry.target.animate([

{

opacity:0,

transform:"translateY(60px)"

},

{

opacity:1,

transform:"translateY(0)"

}

],{

duration:800,

fill:"forwards"

});

}

});

});

reveal.forEach(sec=>observer.observe(sec));
/* ===========================================================
   PART 2 / 3
===========================================================*/

/* -----------------------
Floating Particles
----------------------- */

const particleContainer=document.createElement("div");
particleContainer.id="particles";
document.body.appendChild(particleContainer);

for(let i=0;i<40;i++){

const p=document.createElement("div");

p.className="particle";

p.style.left=Math.random()*100+"vw";

p.style.animationDuration=(12+Math.random()*15)+"s";

p.style.animationDelay=(Math.random()*8)+"s";

p.style.opacity=Math.random();

particleContainer.appendChild(p);

}

/* -----------------------
Counter Animation
----------------------- */

document.querySelectorAll("[data-counter]").forEach(counter=>{

const target=parseInt(counter.dataset.counter);

let value=0;

const speed=Math.max(10,Math.floor(target/120));

const timer=setInterval(()=>{

value+=speed;

if(value>=target){

value=target;

clearInterval(timer);

}

counter.innerText=value.toLocaleString();

},16);

});

/* -----------------------
Touch Moss
----------------------- */

const moss=document.getElementById("touchMoss");

if(moss){

moss.addEventListener("click",()=>{

const mossQuotes=[

"🌿 Moss touched successfully.",

"🦀 The crab approves.",

"🌱 Stay based.",

"🍀 Luck increased +1.",

"📈 Conviction restored.",

"💜 Purple energy detected."

];

alert(

mossQuotes[

Math.floor(Math.random()*mossQuotes.length)

]

);

});

}

/* -----------------------
Random Glow Pulse
----------------------- */

setInterval(()=>{

document.body.animate([

{

filter:"brightness(1)"

},

{

filter:"brightness(1.03)"

},

{

filter:"brightness(1)"

}

],{

duration:900

});

},12000);
/* ===========================================================
   PART 3 / 3
===========================================================*/

/* -----------------------
Hero Crab Click Easter Egg
----------------------- */

const crab=document.querySelector(".hero-right img");

if(crab){

let clickCount=0;

crab.style.cursor="pointer";

crab.addEventListener("click",()=>{

clickCount++;

crab.animate([

{

transform:"scale(1)"

},

{

transform:"scale(1.08)"

},

{

transform:"scale(1)"

}

],{

duration:250

});

if(clickCount===10){

clickCount=0;

alert("🦀 SECRET UNLOCKED!\n\nThe crab believes in you.\n\nNow go touch moss.");

}

});

}

/* -----------------------
Keyboard Secret
Type : CRAB
----------------------- */

let secret="";

document.addEventListener("keydown",(e)=>{

secret+=e.key.toUpperCase();

if(secret.length>4){

secret=secret.slice(-4);

}

if(secret==="CRAB"){

document.body.animate([

{

filter:"hue-rotate(0deg)"

},

{

filter:"hue-rotate(45deg)"

},

{

filter:"hue-rotate(0deg)"

}

],{

duration:1200

});

alert("🦀 CRAB MODE ACTIVATED");

secret="";

}

});

/* -----------------------
Button Ripple Effect
----------------------- */

document.querySelectorAll(".button").forEach(btn=>{

btn.addEventListener("click",(e)=>{

const ripple=document.createElement("span");

const rect=btn.getBoundingClientRect();

const size=Math.max(rect.width,rect.height);

ripple.style.width=size+"px";

ripple.style.height=size+"px";

ripple.style.left=(e.clientX-rect.left-size/2)+"px";

ripple.style.top=(e.clientY-rect.top-size/2)+"px";

ripple.style.position="absolute";

ripple.style.borderRadius="50%";

ripple.style.background="rgba(255,255,255,.35)";

ripple.style.transform="scale(0)";

ripple.style.transition=".6s";

ripple.style.pointerEvents="none";

btn.style.position="relative";

btn.style.overflow="hidden";

btn.appendChild(ripple);

requestAnimationFrame(()=>{

ripple.style.transform="scale(4)";

ripple.style.opacity="0";

});

setTimeout(()=>{

ripple.remove();

},600);

});

});

/* -----------------------
Navbar Shadow On Scroll
----------------------- */

const nav=document.querySelector("nav");

window.addEventListener("scroll",()=>{

if(window.scrollY>80){

nav.style.boxShadow="0 20px 40px rgba(0,0,0,.35)";

}else{

nav.style.boxShadow="none";

}

});

/* -----------------------
Console Easter Egg
----------------------- */

console.log("%c🦀 CRABSEM","font-size:32px;color:#9b5cff;font-weight:bold;");
console.log("%cThe strongest communities keep posting through every dip.","color:#d2b6ff;font-size:16px;");
