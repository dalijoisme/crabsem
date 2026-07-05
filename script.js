*{
    margin:0;
    padding:0;
    box-sizing:border-box;
}

body{

    font-family:Poppins,sans-serif;

    background:#12001f;

    color:white;

    overflow-x:hidden;

}

.background{

    position:fixed;

    inset:0;

    background:
    radial-gradient(circle at top,#6127d6 0%,#25003b 35%,#12001f 80%);

    z-index:-2;

}

.background::after{

    content:"";

    position:absolute;

    inset:0;

    background-image:

    radial-gradient(#ffffff22 1px,transparent 1px);

    background-size:40px 40px;

    opacity:.15;

}

.hero{

    min-height:100vh;

    display:flex;

    flex-direction:column;

    justify-content:center;

    align-items:center;

    text-align:center;

    padding:40px;

}

.crab{

    width:320px;

    max-width:80vw;

    animation:float 4s ease-in-out infinite;

    filter:drop-shadow(0 0 35px #a855ff);

}

h1{

    margin-top:20px;

    font-family:"Luckiest Guy",cursive;

    font-size:80px;

    letter-spacing:4px;

    color:#c96cff;

    text-shadow:

    0 0 15px #9f4cff,

    0 0 35px #7b2fff;

}

.subtitle{

    margin-top:20px;

    font-size:24px;

    opacity:.9;

}

button{

    margin-top:35px;

    border:none;

    cursor:pointer;

    padding:18px 42px;

    border-radius:999px;

    background:#8d38ff;

    color:white;

    font-weight:bold;

    font-size:18px;

    transition:.25s;

    box-shadow:0 0 30px #8d38ff88;

}

button:hover{

    transform:scale(1.08);

    background:#a957ff;

}

.quoteBox{

    width:min(900px,90%);

    margin:auto;

    margin-bottom:120px;

    background:#ffffff10;

    border:1px solid #ffffff18;

    backdrop-filter:blur(18px);

    border-radius:28px;

    padding:40px;

}

.quoteBox h2{

    font-size:34px;

    margin-bottom:20px;

}

.quoteBox p{

    font-size:24px;

    line-height:1.6;

    opacity:.95;

}

@keyframes float{

    0%{transform:translateY(0)}

    50%{transform:translateY(-18px)}

    100%{transform:translateY(0)}

}
