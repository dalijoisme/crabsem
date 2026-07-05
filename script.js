// =========================
// CRABSEM V1
// =========================

const btn = document.getElementById("touchBtn");
const message = document.getElementById("message");
const crab = document.querySelector(".crab");

const quotes = [

    "🌿 touching moss... anxiety reduced by 1%",

    "🦀 one more chart won't hurt.",

    "💜 still early.",

    "📈 zoom out.",

    "🌊 embrace the tide.",

    "🟣 trust your claws.",

    "🍃 go touch moss.",

    "🚀 maybe today.",

    "✨ vibes restored."

];

btn.addEventListener("click", () => {

    const random =
        quotes[Math.floor(Math.random() * quotes.length)];

    message.innerHTML = random;

    message.classList.add("show");

});


// Hover animation

crab.addEventListener("mouseenter", () => {

    crab.style.transform = "scale(1.05) rotate(-2deg)";

});

crab.addEventListener("mouseleave", () => {

    crab.style.transform = "";

});


// Click animation

crab.addEventListener("click", () => {

    crab.animate([

        {
            transform:"rotate(0deg)"
        },

        {
            transform:"rotate(-10deg)"
        },

        {
            transform:"rotate(10deg)"
        },

        {
            transform:"rotate(0deg)"
        }

    ],{

        duration:400

    });

});


// Fade-in saat website dibuka

window.addEventListener("load",()=>{

    document.body.style.opacity="1";

});
