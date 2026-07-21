## Inspiration

Between having a full time job and being the father of two young kids, personal coding projects pretty much had vanished from existence. The advent of AI and so called vibe coding  has made those a reality. I think have never made so many cool little personal projects as I have recently. 

However, every time I got excited about implement fun AI features I hit the wall that API rates are simply far too expensive for simple, free, personal everyday apps. AI subscriptions want you to use their apps and can't be easily integrated to 3rd party ones.

So I thought, wouldn't it be cool if I could plug the codex  I get from my OpenAI subscription into my personal vibe coded shopping list app? So that i could get the power of frontier models on my tiny simple personal app? What would it take to do so? And how could I allow others to do the same? 

That's how the idea behind Agent Connect came to be.

## What it does

It's a framework to give AI features to apps by leveraging user's coding agents from their subscriptions.

There are two sides to it.

From app developer's side, agent connect is an SDK. You define tools, attach a handler to each, pass in the identifying info to connect to a remote agent and bam. AI features powered by users' coding agents.

From a user's perspective, Agent Connect  is a program you launch on your side. On your laptop, a remote VM, an ephemeral dev env, etc. As long as it can be made safely reachable through the internet. Tailscale fills this role on the MVP. This Agent Connect program acts as a kind of gateway that will handle authentication and will manage an Omnigent instance that itself will orchestrate a codex instance through ACP.

Once both exist, the user's flow is:
- Start the Agent Connect Gateway on your VM/laptop/etc.
- Save the generated runtime card and secret passphrase somewhere. A password manager is a good place for them (like Dashlane 1313)
- Start tailscale.aerve to expose the Agent Connect Gateway.
- Now the user has an agent available for work anywhere.
- Open an app that implemented tools and plugged them to the Agent Connect SDK.
- Enter the runtime card in the webapp, get redirected to am auth paged server by the Agent Connect Gateway.
- Enter the secret passphrase and allow the permission grant being asked for by the webapp.
- Get redirected back to the webapp, with the material to open a persistent connection to the Agent Connect Gateway.
- Now the user's agent is ready to interact with the app through tool calls remotely 🎉🎉 All the user has to do is prompt and the remote agent does its magic.

## How we built it

This was built in closer partnership with GPT 5.6 Sol through codex. It started as a discussion and exploration and research with subagents. 

Are there standard protocols for this kind of thing that already exist? There is ACP but remote network transport is still in draft. ACP was concierge more so that IDEs could talk to local coding agents. Still, the shape isn't too far off from the idea. 

I'd also recently heard from Databrick's Omnigent. At first I'd dismissed it as unnecessary overhead for running coding agents, but the more I thought about the problems to be solved to orchestrate an agent, the more I understood the value in a thing like Omnigent, and I realized it already did a lot of what I wanted to have, like Orchestrate agents in a harness-agnostic-ish way. Seemed more and more like a good fit.

Then came the problem of "dynamic tools". The current common approach is you define tools in advance in the harness side. Or at least install some kind of MCP. What I was imagining required defining and presenting the tools from the client side to a running setup. Omniagent can deal with this by setting up an MCP relay dynamically at the start of a session.

The next part was how to expose this on the internet to be called by some 3rd party app. For personal apps, tailscale would've probably been enough, but if this was to become a "library" and "utility tool" we needed to push security further. 

I did some threat modeling by going back and forth with codex. At it's core the problem is two fold:
1 how does agent know it can trust and should act in the tasks coming from external calls.
2 how does the webapp know that the agent it is being pointed at actually belongs to.the user and can be trusted, at least to some extent.

Then as one digs into the details other security concerns pop up. We came up with an authentication flow to handle these. The goal was for both sides to authenticate each other. 

The gateway checks which app origin is requesting access and shows the user the tools it want to give to the agents. 

The app uses a runtime card to target and verify the identity of  the gateway. On first use, the browser leaves the app and opens a page served by the gateway. That is where the user enters the enrollment passphrase and approves the grant, so the app itself never sees the secret.

The resulting session is bound to the app origin and the exact tool definitions the user approved. If the app changes its tools, it has to ask again. Access can also be revoked from the gateway.

## Challenges we ran into

The first major challenge of this project was able to dynamically define the tools available to an agent remotely. This embedded up being solved mostly under the hood by Omnigent.

The second major challenge was security. At the end of the day, this project is about opening and remote execution channel to an agent running on the user's boundary. If the app is is also made by the user and everything is running inside their own tailscale then everything is fine. But if  agent connect is meant to be made available to more people and you end up using it with third-party apps. The security story changes and we need to secure the channel and make sure about who's talking to who.

A third major challenge is that this domain is very young and I would have preferred to use some existing standard protocol for the communication between the SDK and the Gateway in such a way that the SDK could be more.agntostic of what was being used behind the scenes to run the agent. The hackathon MVP is  tightly coupled with Omnigent, which isn't unnecessarily a bad thing, but it means that people have to deploy Omnigent instead of just being able to use something that talks ACP and something not yet stable like MCP-over-ACP.

## Accomplishments that we're proud of

Agent connect actually works and I now have AI features on my shopping list app that I managed to convince some close ones to actually use.

I think the security store is pretty solid even if it's not perfect. Agent connect cannot guarantee that the gateway environment hasn't been compromised or that the third-party app isn't malicious. It  Can implement whatever handler it wants. But even so, I'm proud that the final shape cares about trying to protect the user to some extent.

## What I learned

First, the GPT 5.6 Sol on medium is absurdly capable. Customer the full project designed and implemented through it. And it was interesting because for the public demo we had to move out of the private. Their skills serve method into a public tail scale funnel and it found a security issue all by itself and that the Grant page suddenly became Anonymous. I would have expected it to catch something like that when prompted for it, but I didn't expect it to autonomously. Find it out as it implemented the alternative public version for the demo. 

I also learned that omnigent is awesome. They've done a Really cool thing but over at data bricks.

Fine of you. Let's say it. I learn much about the the complexities of remotely managing an agent is responses and it's tool calls keeping a session online. Thinking of how to deal with reconnects with unfinished true calls and that kind of thing. It'll be an interesting future for this project for sure, but even in its current state it's already usable and it feels great.

## What's next for Agent Connect: Bring your own agent

The next steps for the project is first cleaning up All the AI "artifacts" that get created when a project is developed in such a way with a cutting harness. 

Then I'd like to explore about switching to a more open protocol like AG-UI<link> for the communication between the SDK and the Gateway because it seems like a good fit.

I had also wanted to write some other profiles which to connect the SDK to the Gateway, for example by using Microsoft tunnels like the ones used by vs. Code or simply being enabled to Target a local running Gateway instance on the same laptop or even using FML environment in some cloud provider to make it really easy to use for a user that's not super technical and doesn't want to have like a remote VM with tail scale and that kind of stuff. It's definitely doable. 

The underlying goal  is to make agent connect easier to use and accessible to anyone so that it can potentially become a common way of integrating ai features and making them available to any user that has an AI subscription, especially those that will know how to set this something like this up by themselves. Good and simple packaging for a thing like this is essential
